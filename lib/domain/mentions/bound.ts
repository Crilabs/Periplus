import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, mentions } from "@/lib/db/schema";
import { jsonUuids } from "./scope";
import type { ChunkRef } from "./store";

/*
 * Binding to the place (spec 16 C „Bindung an den Ort“): every page under the start URL of a place's own website
 * (`place_websites` row with `bound`) says something about that place, with or without its name. Such a page gets one
 * zero-length mention per chunk (`match_kind = 'bound'`), so its extraction units cover the whole page and the facts
 * hang on a mention of the place.
 */

/** Merge chains are short; the cap only guards against a cycle. */
const MAX_MERGE_HOPS = 10;

type Candidate = { place_id: string; url_normalized: string };

/** Whether `url` lies under the start URL `start`: same prefix, ending on a path boundary. */
function isUnder(url: string, start: string): boolean {
  if (!url.startsWith(start)) return false;
  if (start.endsWith("/") || url.length === start.length) return true;
  return url[start.length] === "/" || url[start.length] === "?";
}

/**
 * The geo object a page is bound to: that of the place whose current `place_websites` row has `bound = true`, is not
 * of an `authority` source and whose start URL is the longest prefix of `urlNormalized` (path prefix on the same
 * host). A merged place resolves to the one it was merged into; null when there is none, when two places tie, or when
 * the place is rejected.
 */
export async function boundGeoObjectFor(db: Db, urlNormalized: string): Promise<string | null> {
  const { rows } = await db.execute<Candidate>(sql`
    select c.place_id, c.url_normalized
    from (
      select distinct on (w.place_id) w.place_id, w.url_normalized, w.bound, w.source_id
      from place_websites w
      where w.place_id in (select place_id from place_websites where starts_with(${urlNormalized}, url_normalized))
      order by w.place_id, w.created_at desc, w.id desc
    ) c
    left join sources s on s.id = c.source_id
    where c.bound and s.type is distinct from 'authority' and starts_with(${urlNormalized}, c.url_normalized)
  `);
  const under = rows.filter((r) => isUnder(urlNormalized, r.url_normalized));
  if (under.length === 0) return null;

  // Resolve merged places to their survivors; the same survivor reached twice is one place.
  const survivors = new Map<string, { placeId: string; length: number }>();
  for (const r of under) {
    const placeId = await survivorOf(db, r.place_id);
    if (placeId === null) continue;
    const length = Math.max(r.url_normalized.length, survivors.get(placeId)?.length ?? 0);
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
