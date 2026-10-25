import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, mentions } from "@/lib/db/schema";
import { jsonUuids } from "@/lib/domain/research/util/json-uuids";
import { bindingKey, bindingKeySql } from "@/lib/domain/places/binding-key";
import type { ChunkRef } from "./store";

/*
 * Binding to the place (spec 15 C „Bindung an den Ort“): every page under the start URL of a place's own website
 * (`place_websites` row with `bound`) says something about that place, with or without its name. Such a page gets one
 * zero-length mention per chunk (`match_kind = 'bound'`), so its extraction units cover the whole page and the facts
 * hang on a mention of the place.
 */

/** Merge chains are short; the cap only guards against a cycle. */
const MAX_MERGE_HOPS = 10;

type Candidate = { place_id: string; url_normalized: string };

/** Whether `url` lies under the start URL `start` (both binding keys): same prefix, ending on a path boundary. */
function isUnder(url: string, start: string): boolean {
  if (!url.startsWith(start)) return false;
  if (start.endsWith("/") || url.length === start.length) return true;
  return url[start.length] === "/" || url[start.length] === "?";
}

/**
 * The geo object a page is bound to: that of the place whose current `place_websites` row has `bound = true`, is not
 * of an `authority` source and whose start URL is the longest prefix of `urlNormalized` (path prefix on the same
 * host, compared by `bindingKey`: scheme and `www.` do not matter). A merged place resolves to the one it was merged into; null when there is none, when two places tie, or when
 * the place is rejected.
 */
export async function boundGeoObjectFor(db: Db, urlNormalized: string): Promise<string | null> {
  const key = bindingKey(urlNormalized);
  const { rows } = await db.execute<Candidate>(sql`
    select c.place_id, c.url_normalized
    from (
      select distinct on (w.place_id) w.place_id, w.url_normalized, w.bound, w.source_id
      from place_websites w
      where w.place_id in (select place_id from place_websites where starts_with(${key}, ${bindingKeySql(sql`url_normalized`)}))
      order by w.place_id, w.created_at desc, w.id desc
    ) c
    left join sources s on s.id = c.source_id
    where c.bound and s.type is distinct from 'authority' and starts_with(${key}, ${bindingKeySql(sql`c.url_normalized`)})
  `);
  const under = rows.map((r) => ({ place_id: r.place_id, key: bindingKey(r.url_normalized) })).filter((r) => isUnder(key, r.key));
  if (under.length === 0) return null;

  // Resolve merged places to their survivors; the same survivor reached twice is one place.
  const survivors = new Map<string, { placeId: string; length: number }>();
  for (const r of under) {
    const placeId = await survivorOf(db, r.place_id);
    if (placeId === null) continue;
    const length = Math.max(r.key.length, survivors.get(placeId)?.length ?? 0);
    survivors.set(placeId, { placeId, length });
  }
  const longest = Math.max(...[...survivors.values()].map((s) => s.length));
  const best = [...survivors.values()].filter((s) => s.length === longest);
  if (best.length !== 1) return null;

  const { rows: placeRows } = await db.execute<{ geo_object_id: string; status: string }>(sql`
    select geo_object_id, status from places where id in ${jsonUuids([best[0]!.placeId])}
  `);
  const place = placeRows[0];
  return place && place.status !== "rejected" ? place.geo_object_id : null;
}

/** The place at the end of the `merged_into_id` chain; null on a cycle. */
async function survivorOf(db: Db, placeId: string): Promise<string | null> {
  let id = placeId;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    const { rows } = await db.execute<{ merged_into_id: string | null }>(sql`select merged_into_id from places where id = ${id}`);
    const next = rows[0]?.merged_into_id ?? null;
    if (next === null) return id;
    id = next;
  }
  return null;
}

/** The geo object the document of a version is bound to (`boundGeoObjectFor` of its normalised URL). */
export async function boundGeoObjectOfVersion(db: Db, versionId: string): Promise<string | null> {
  const [row] = await db
    .select({ url: documents.urlNormalized })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(eq(documentVersions.id, versionId));
  return row ? boundGeoObjectFor(db, row.url) : null;
}

/**
 * The current versions of active documents of the sources `sourceIds` that lie under a currently bound start URL
 * (`boundGeoObjectFor` names an object) but have no `bound` mention yet, in id order (final review 3): pages fetched and
 * matched before the website was attached (an already approved source, a start URL fetched before) are not pending, so a
 * marina website run takes them in explicitly; the match adds their bound mentions idempotently (`storeBoundMention`)
 * and the extraction only the new mentions.
 */
export async function unboundVersionsUnderBoundStarts(db: Db, sourceIds: string[]): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const { rows } = await db.execute<{ id: string; url_normalized: string }>(sql`
    with cur as (
      select distinct on (w.place_id) w.place_id, w.url_normalized, w.bound
      from place_websites w
      order by w.place_id, w.created_at desc, w.id desc
    )
    select v.id, d.url_normalized
    from documents d
    join document_versions v on v.id = d.current_version_id
    where d.status = 'active' and d.valid_to is null and d.source_id in ${jsonUuids(sourceIds)}
      and exists (
        select 1 from cur where cur.bound and starts_with(${bindingKeySql(sql`d.url_normalized`)}, ${bindingKeySql(sql`cur.url_normalized`)})
      )
      and not exists (select 1 from mentions m where m.document_version_id = v.id and m.match_kind = 'bound')
    order by v.id
  `);
  const out: string[] = [];
  for (const r of rows) if ((await boundGeoObjectFor(db, r.url_normalized)) !== null) out.push(r.id);
  return out;
}

/**
 * One bound mention of the object on the chunk: zero length at the start (`surface` empty, `confidence` 1, no type
 * hint). Idempotent through the mentions' unique index; returns whether it is new.
 */
export async function storeBoundMention(db: Db, ref: ChunkRef, geoObjectId: string, observedAt: string): Promise<boolean> {
  const rows = await db
    .insert(mentions)
    .values({
      documentVersionId: ref.versionId,
      chunkId: ref.chunkId,
      geoObjectId,
      surface: "",
      charStart: 0,
      charEnd: 0,
      typeHint: null,
      observedAt,
      confidence: 1,
      matchKind: "bound",
      runId: ref.runId,
    })
    .onConflictDoNothing()
    .returning({ id: mentions.id });
  return rows.length > 0;
}
