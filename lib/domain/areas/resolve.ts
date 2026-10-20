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
 * One preference level: the entries `indexes` against `candidates`, each entry as one n-gram on disjoint offsets so
 * `resolveHits` decides it as its own span. Returns the entries with any hit: the object of a sure hit, null for an
 * ambiguous one. Entries without a hit are missing from the map.
 */
async function matchLevel(
  db: Db,
  entries: MemberEntry[],
  indexes: number[],
  candidates: string[],
  match: MatchConfig,
): Promise<Map<number, string | null>> {
  const decided = new Map<number, string | null>();
  if (candidates.length === 0) return decided;
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
  const hits = await findNameHits(db, nameFormsOf(grams, match), candidates, match);
  // Bot member names are typed names, never words of a running text: no common-word refinement.
  for (const r of resolveHits(hits, match, { commonWords: false })) {
    const i = entryAt.get(r.kind === "sure" ? r.hit.start : r.start)!;
    decided.set(i, r.kind === "sure" ? r.hit.geoObjectId : null);
  }
  return decided;
}

/**
 * Resolves the entries (member and boundary-point names with their bot type) among the scope objects of
 * `subdivisionIds` whose type `cfg.areas.memberTypes[type]` allows, type by type in that order (`matchLevel`). Every
 * entry is one span of the spec-06 match (`nameForms` → `findNameHits` → `resolveHits`); only a `sure` result
 * resolves. Runs in one transaction (a savepoint inside the caller's) so the trigram threshold holds. Both lists keep
 * the order of `entries`.
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
    // `set_config(…, true)` is transaction-local: inside the caller's transaction the threshold stays in effect for the
    // rest of that outer transaction, not just this savepoint.
    await setTrigramThreshold(tx, cfg.mentions.uncertainSimilarity);
    const scope = await scopeObjects(tx, subdivisionIds, cfg.areas.neighbourRing);
    const byType = new Map<string, number[]>();
    entries.forEach((e, i) => byType.set(e.type, [...(byType.get(e.type) ?? []), i]));
    for (const [type, indexes] of byType) {
      // `memberTypes[type]` is an order of preference: a harbour and its town share their name (Poros, Hydra), so a
      // `harbour` entry is matched among harbours first and only an entry without any hit there among settlements.
      // An ambiguous result at one level is final (Review Focus 1): it never falls through to a lower preference.
      let pending = indexes;
      for (const objectType of cfg.areas.memberTypes[type] ?? []) {
        if (pending.length === 0) break;
        const decided = await matchLevel(tx, entries, pending, await ofTypes(tx, scope, [objectType]), match);
        for (const [i, id] of decided) if (id) sure.set(i, id);
        pending = pending.filter((i) => !decided.has(i));
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
