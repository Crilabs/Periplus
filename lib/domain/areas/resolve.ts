import { sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { GeoObjectType } from "@/lib/db/schema";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { findNameHits, nameFormsOf, resolveHits, setTrigramThreshold, type MatchConfig } from "@/lib/domain/mentions/match";
import { nameForms, type Ngram } from "@/lib/domain/mentions/ngrams";
import { candidateObjects, jsonTexts, jsonUuids, withNeighbours } from "@/lib/domain/mentions/scope";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";

/*
 * Member names of a bot area against the gazetteer (spec 14, „Änderung 21.10.2026“): the name match of spec 06,
 * restricted to the named subdivisions and their neighbour tiles, the candidates narrowed by the file's type. Only a
 * single sure hit resolves a name; a name that is ambiguous (twice in the scope, uncertain similarity) stays unresolved
 * rather than pulling the polygon across the sea.
 */

export type MemberRole = "member" | "boundary";
export type MemberEntry = { name: string; type: string; role: MemberRole };
export type ResolvedMember = { geoObjectId: string; name: string; role: MemberRole };

/**
 * The valid subdivisions the file's keys name. A key replaced by `split` (`GR-L`) stands for its group keys; a key
 * (or group key) without a valid subdivision lands in `unknown`. Ids without duplicates, in the order of the keys.
 */
export async function scopeSubdivisionIds(
  db: Db,
  keys: string[],
  cfg: AppConfig,
): Promise<{ ids: string[]; unknown: string[] }> {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    const split = cfg.subdivisions.split.find((s) => s.parentKey === key);
    for (const k of split ? split.groups.map((g) => g.key) : [key]) {
      const sub = await subdivisionByKey(db, k);
      if (!sub) {
        if (!unknown.includes(k)) unknown.push(k);
      } else if (!ids.includes(sub.id)) {
        ids.push(sub.id);
      }
    }
  }
  return { ids, unknown };
}

/**
 * The candidate objects of the scope: valid, unmerged objects assigned to one of the subdivisions, plus the objects of
 * the subdivisions' scope tiles with `neighbourRing` rings of neighbours (and their ancestors, `candidateObjects`).
 */
async function scopeObjects(db: Db, subdivisionIds: string[], ring: number): Promise<string[]> {
  if (subdivisionIds.length === 0) return [];
  const tiles = new Set<string>();
  for (const id of subdivisionIds) for (const t of await subdivisionTileIds(db, id)) tiles.add(t);
  const fromTiles = await candidateObjects(db, withNeighbours(tiles, ring));
  const { rows } = await db.execute<{ id: string }>(sql`
    select o.id from geo_objects o
    where o.subdivision_id in ${jsonUuids(subdivisionIds)}
      and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date) and o.merged_into_id is null`);
  return [...new Set([...fromTiles, ...rows.map((r) => r.id)])];
}

/** Of `ids`, those whose type is one of `types`. */
async function ofTypes(db: Db, ids: string[], types: readonly GeoObjectType[]): Promise<string[]> {
  if (ids.length === 0 || types.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    select o.id from geo_objects o where o.id in ${jsonUuids(ids)} and o.type::text in ${jsonTexts(types)}`);
  return rows.map((r) => r.id);
}

/**
 * Resolves the entries (member and boundary-point names with their bot type) among the scope objects of
 * `subdivisionIds` whose type `cfg.areas.memberTypes[type]` allows. Every entry is one span of the spec-06 match
 * (`nameForms` → `findNameHits` → `resolveHits`); only a `sure` result resolves. Runs in one transaction (a savepoint
 * inside the caller's) so the trigram threshold holds. Both lists keep the order of `entries`.
 */
export async function resolveAreaMembers(
  db: Db,
  entries: MemberEntry[],
  subdivisionIds: string[],
  cfg: AppConfig,
): Promise<{ resolved: ResolvedMember[]; unresolved: MemberEntry[] }> {
  const match: MatchConfig = { mentions: cfg.mentions, nameAffixes: cfg.nameAffixes };
  const sure = new Map<number, string>();
  await db.transaction(async (tx) => {
    await setTrigramThreshold(tx, cfg.mentions.uncertainSimilarity);
    const scope = await scopeObjects(tx, subdivisionIds, cfg.areas.neighbourRing);
    const byType = new Map<string, number[]>();
    entries.forEach((e, i) => byType.set(e.type, [...(byType.get(e.type) ?? []), i]));
    for (const [type, indexes] of byType) {
      const candidates = await ofTypes(tx, scope, cfg.areas.memberTypes[type] ?? []);
      if (candidates.length === 0) continue;
      // One n-gram per entry on disjoint offsets, so `resolveHits` decides every entry as its own span.
      const grams: Ngram[] = [];
      const entryAt = new Map<number, number>();
      let offset = 0;
      for (const i of indexes) {
        const name = entries[i]!.name;
        const forms = nameForms(name);
        if (forms.length === 0) continue;
        grams.push({ start: offset, end: offset + name.length, surface: name, forms, words: forms[0]!.split(" ").length });
        entryAt.set(offset, i);
        offset += name.length + 1;
      }
      const hits = await findNameHits(tx, nameFormsOf(grams, match), candidates, match);
      for (const r of resolveHits(hits, match)) {
        if (r.kind === "sure") sure.set(entryAt.get(r.hit.start)!, r.hit.geoObjectId);
      }
    }
  });
  const resolved: ResolvedMember[] = [];
  const unresolved: MemberEntry[] = [];
  entries.forEach((e, i) => {
    const id = sure.get(i);
    if (id) resolved.push({ geoObjectId: id, name: e.name, role: e.role });
    else unresolved.push(e);
  });
  return { resolved, unresolved };
}
