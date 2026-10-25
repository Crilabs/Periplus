import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks } from "@/lib/db/schema";
import { boundGeoObjectOfVersion, storeBoundMention } from "@/lib/domain/mentions/bound";
import { effectiveVersionMeta } from "@/lib/domain/mentions/classification";
import { findNameHits, nameFormsOf, resolveHits, setTrigramThreshold, type MatchHit, type ResolvedMatch } from "@/lib/domain/mentions/match";
import { linkTextOnly, ngrams } from "@/lib/domain/mentions/ngrams";
import { activeSubdivisionKeys } from "@/lib/domain/subdivisions/store";
import { candidateObjects, candidateTiles, jsonTexts } from "@/lib/domain/mentions/scope";
import { jsonUuids } from "@/lib/domain/research/util/json-uuids";
import {
  MATCH_PASS_STAGE,
  mentionSpans,
  mentionsConfigKey,
  recordMatchPass,
  settleCoveredAmbiguous,
  storeAmbiguous,
  storeSureMentions,
  storeUnmatched,
  type AmbiguousDraft,
  type UnmatchedRow,
} from "@/lib/domain/mentions/store";
import { nameHints, type UnmatchedDraft } from "@/lib/domain/mentions/unmatched";
import type { JobData } from "@/lib/jobs/worker";
import { frozenRunVersions } from "./versions";

/*
 * Stage `mentions.batch` (spec 06): the deterministic name match of the text run's versions, `versionsPerJob` per job.
 * Only chunks not carried over from an earlier version are matched (a carried chunk keeps the mentions of its
 * original). Sure hits become mentions, ambiguous spans wait for `mentions.disambiguate`, place hints without a hit are
 * collected for the new-name review. A rematch run (after a "Neuer Name" decision, ruling M4-FIN-R1) matches the
 * carried chunks of the version too, as the name may sit in one: there it adds only what the original chunk does not
 * have (objects it does not mention, spans it neither mentions nor holds as ambiguous), stored on the version's own
 * carried chunk, and collects no place hints (the original collected them).
 * A page under the start URL of a place's own website (`boundGeoObjectFor`, spec 15 C) gets one more mention per
 * chunk, zero-length and `bound`, right after the sure hits and in the same transaction.
 */

export const MENTIONS_STAGE = MATCH_PASS_STAGE;
export const MENTIONS_QUEUE = "mentions.batch" as const;

export type MatchCounts = { mentions: number; ambiguous: number; unmatched: number; chunks: number };

/** Plan: the run's versions, `versionsPerJob` per job (`{ key, versionIds }`, plus `rematch` for a rematch run). */
export async function planMentions(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const ids = await frozenRunVersions(db, run.params);
  const size = config.mentions.versionsPerJob;
  const jobs: JobData[] = [];
  const rematch = run.params.rematch === true ? { rematch: true } : {};
  for (let i = 0; i * size < ids.length; i++) jobs.push({ key: `mentions:${i}`, versionIds: ids.slice(i * size, (i + 1) * size), ...rematch });
  return jobs;
}

type ChunkResult = {
  chunkId: string;
  text: string;
  sure: MatchHit[];
  ambiguous: Extract<ResolvedMatch, { kind: "ambiguous" }>[];
  hints: UnmatchedDraft[];
  /** The chunk gets a bound mention (a page of a place's own website; not when its original already mentions the place). */
  bound: boolean;
};

type Span = { start: number; end: number };
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/** What the original chunk of a carried chunk has already: its mentioned objects and its mention and ambiguous spans. */
type OriginRows = { objects: Set<string>; spans: Span[] };

async function originRows(db: Db, originChunkIds: string[]): Promise<Map<string, OriginRows>> {
  const out = new Map<string, OriginRows>(originChunkIds.map((id) => [id, { objects: new Set<string>(), spans: [] }]));
  if (originChunkIds.length === 0) return out;
  const { rows } = await db.execute<{ chunk_id: string; geo_object_id: string | null; char_start: number; char_end: number }>(sql`
    select chunk_id, geo_object_id, char_start, char_end from mentions where chunk_id in ${jsonUuids(originChunkIds)}
    union all
    select chunk_id, null, char_start, char_end from ambiguous_matches where chunk_id in ${jsonUuids(originChunkIds)}
  `);
  for (const r of rows) {
    const o = out.get(r.chunk_id)!;
    if (r.geo_object_id) o.objects.add(r.geo_object_id);
    o.spans.push({ start: r.char_start, end: r.char_end });
  }
  return out;
}
const spanOf = (r: ResolvedMatch) => (r.kind === "sure" ? r.hit : r);
const gap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start >= b.end ? a.start - b.end : b.start >= a.end ? b.start - a.end : 0;

/** One tile per object: the first by id among the candidate tiles, else the first of all its tiles. */
async function tileOfObjects(db: Db, objectIds: string[], scopeTiles: string[]): Promise<Map<string, string>> {
  if (objectIds.length === 0) return new Map();
  const { rows } = await db.execute<{ geo_object_id: string; tile_id: string }>(sql`
    select distinct on (tgo.geo_object_id) tgo.geo_object_id, tgo.tile_id
    from tile_geo_objects tgo
    where tgo.geo_object_id in ${jsonUuids(objectIds)}
    order by tgo.geo_object_id, (tgo.tile_id in ${jsonTexts(scopeTiles.length > 0 ? scopeTiles : [""])}) desc, tgo.tile_id
  `);
  return new Map(rows.map((r) => [r.geo_object_id, r.tile_id]));
}

/** The tile of a place hint: that of the nearest mentioned object of its chunk, else the version's most frequent. */
function hintTile(hint: UnmatchedDraft, sure: MatchHit[], objectTile: Map<string, string>, versionTile: string | null): string | null {
  const near = sure
    .filter((h) => objectTile.has(h.geoObjectId))
    .sort((a, b) => gap(hint, a) - gap(hint, b) || a.start - b.start)[0];
  return near ? objectTile.get(near.geoObjectId)! : versionTile;
}

/**
 * Matches the uncarried chunks of one version (with `rematch`, its carried chunks too) against the candidate objects
 * and stores mentions, ambiguous spans, unmatched place hints and the version's pass (`mentionsConfigKey`), in one
 * transaction. Idempotent: a second pass adds nothing. Returns the new rows and the number of chunks matched.
 */
export async function matchVersion(
  db: Db,
  versionId: string,
  ctx: { runId: string | null; cfg: AppConfig; rematch?: boolean },
): Promise<MatchCounts> {
  const { cfg } = ctx;
  const matchCfg = { mentions: cfg.mentions, nameAffixes: cfg.nameAffixes };
  return db.transaction(async (tx) => {
    await setTrigramThreshold(tx, cfg.mentions.uncertainSimilarity);
    const meta = await effectiveVersionMeta(tx, versionId);
    const scope = await candidateTiles(tx, versionId, cfg.mentions, { nameAffixes: cfg.nameAffixes, subdivisionKeys: await activeSubdivisionKeys(tx) });
    const objectIds = await candidateObjects(tx, scope.tiles);
    const rows = await tx
      .select({ id: chunks.id, text: chunks.text, origin: chunks.carriedFromChunkId })
      .from(chunks)
      .where(and(eq(chunks.documentVersionId, versionId), ctx.rematch ? undefined : isNull(chunks.carriedFromChunkId)))
      .orderBy(asc(chunks.ordinal));
    const origins = await originRows(tx, rows.flatMap((r) => (r.origin ? [r.origin] : [])));

    const boundObject = await boundGeoObjectOfVersion(tx, versionId);
    const results: ChunkResult[] = [];
    for (const chunk of rows) {
      // Links count with their text only: no n-gram and no place hint from a URL (offsets stay those of the chunk).
      const text = linkTextOnly(chunk.text);
      const hits = await findNameHits(tx, nameFormsOf(ngrams(text, cfg.mentions.maxNgramWords), matchCfg), objectIds, matchCfg);
      const resolved = resolveHits(hits, matchCfg);
      const sure = resolved.flatMap((r) => (r.kind === "sure" ? [r.hit] : []));
      const ambiguous = resolved.flatMap((r) => (r.kind === "ambiguous" ? [r] : []));
      const origin = chunk.origin ? origins.get(chunk.origin)! : null;
      if (origin) {
        // A carried chunk in a rematch: only what its original does not have (the original keeps its own rows).
        results.push({
          chunkId: chunk.id,
          text: chunk.text,
          sure: sure.filter((h) => !origin.objects.has(h.geoObjectId) && !origin.spans.some((o) => overlaps(h, o))),
          ambiguous: ambiguous.filter((a) => !origin.spans.some((o) => overlaps(a, o))),
          hints: [],
          bound: boundObject !== null && !origin.objects.has(boundObject),
        });
        continue;
      }
      results.push({
        chunkId: chunk.id,
        text: chunk.text,
        sure,
        ambiguous,
        hints: nameHints(text, cfg.nameAffixes, cfg.mentions.nameHintStopWords).filter((h) => !resolved.some((r) => overlaps(h, spanOf(r)))),
        bound: boundObject !== null,
      });
    }

    const sureObjects = [...new Set(results.flatMap((r) => r.sure.map((h) => h.geoObjectId)))];
    const objectTile = await tileOfObjects(tx, sureObjects, scope.tiles);
    const tileCounts = new Map<string, number>();
    for (const r of results) {
      for (const h of r.sure) {
        const tile = objectTile.get(h.geoObjectId);
        if (tile) tileCounts.set(tile, (tileCounts.get(tile) ?? 0) + 1);
      }
    }
    const versionTile = [...tileCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

    const counts: MatchCounts = { mentions: 0, ambiguous: 0, unmatched: 0, chunks: rows.length };
    const unmatched: UnmatchedRow[] = [];
    for (const r of results) {
      const ref = { versionId, chunkId: r.chunkId, runId: ctx.runId };
      counts.mentions += await storeSureMentions(
        tx,
        ref,
        r.sure.map((hit) => ({ hit, surface: r.text.slice(hit.start, hit.end) })),
        meta.observedAt,
      );
      // Every chunk of a page under the place's own website: a zero-length mention, so the page is extracted whole.
      if (r.bound && boundObject !== null && (await storeBoundMention(tx, ref, boundObject, meta.observedAt))) counts.mentions++;
    }
    // A span is a mention or waits for the disambiguation, never both (a rematch with another configuration may turn
    // a sure hit ambiguous or an ambiguous one sure): an ambiguous span over an existing mention is not stored, and a
    // pending ambiguous row a mention now covers is settled as `resolved` (the disambiguation then skips it).
    const covered = await mentionSpans(tx, versionId);
    for (const r of results) {
      const ref = { versionId, chunkId: r.chunkId, runId: ctx.runId };
      const spans = covered.get(r.chunkId) ?? [];
      const drafts: AmbiguousDraft[] = r.ambiguous
        .filter((a) => !spans.some((m) => overlaps(a, m)))
        .map((a) => ({ ...a, surface: r.text.slice(a.start, a.end) }));
      counts.ambiguous += await storeAmbiguous(tx, ref, drafts);
    }
    await settleCoveredAmbiguous(tx, versionId);
    for (const r of results) {
      for (const h of r.hints) {
        unmatched.push({
          nameNormalized: h.nameNormalized,
          displayName: h.display,
          hint: h.hint,
          chunkId: r.chunkId,
          tileId: hintTile(h, r.sure, objectTile, versionTile),
        });
      }
    }
    counts.unmatched = await storeUnmatched(tx, versionId, meta.sourceId, unmatched);
    await recordMatchPass(tx, versionId, mentionsConfigKey(cfg), ctx.runId);
    return counts;
  });
}

/** One job of the stage: matches its versions one after another (each in its own transaction). */
export async function matchVersions(
  db: Db,
  job: { runId: string; versionIds: string[]; rematch?: boolean },
  cfg: AppConfig = getConfig(),
): Promise<MatchCounts> {
  const total: MatchCounts = { mentions: 0, ambiguous: 0, unmatched: 0, chunks: 0 };
  for (const id of job.versionIds) {
    const c = await matchVersion(db, id, { runId: job.runId, cfg, rematch: job.rematch === true });
    total.mentions += c.mentions;
    total.ambiguous += c.ambiguous;
    total.unmatched += c.unmatched;
    total.chunks += c.chunks;
  }
  return total;
}
