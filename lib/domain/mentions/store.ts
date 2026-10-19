import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { ambiguousMatches, mentions, pipelinePasses, unmatchedNames } from "@/lib/db/schema";
import { canonicalJson } from "@/lib/domain/facts/schema";
import type { Hint } from "./affixes";
import type { MatchCandidate, MatchHit } from "./match";

/*
 * Rows of the name match (spec 06): sure hits become `mentions` (append-only), ambiguous spans `ambiguous_matches`,
 * place hints without any hit `unmatched_names`, and a finished version a `pipeline_passes` row. Every write is
 * idempotent through the table's unique index, so a repeated pass adds nothing.
 */

/** The `pipeline_passes.stage` of the match (the stage `mentions.batch`). */
export const MATCH_PASS_STAGE = "mentions.batch";

/** Identifies the match configuration of a pass: `"mentions:" + sha256(canonicalJson({ mentions, nameAffixes }))[0..12]`. */
export function mentionsConfigKey(cfg: Pick<AppConfig, "mentions" | "nameAffixes">): string {
  const hash = createHash("sha256").update(canonicalJson({ mentions: cfg.mentions, nameAffixes: cfg.nameAffixes })).digest("hex");
  return `mentions:${hash.slice(0, 12)}`;
}

export type ChunkRef = { versionId: string; chunkId: string; runId: string | null };

/** Sure hits as deterministic mentions (`confidence` = `match_score` = similarity); returns how many are new. */
export async function storeSureMentions(db: Db, ref: ChunkRef, hits: Array<{ hit: MatchHit; surface: string }>, observedAt: string): Promise<number> {
  if (hits.length === 0) return 0;
  const rows = await db
    .insert(mentions)
    .values(
      hits.map(({ hit, surface }) => ({
        documentVersionId: ref.versionId,
        chunkId: ref.chunkId,
        geoObjectId: hit.geoObjectId,
        surface,
        charStart: hit.start,
        charEnd: hit.end,
        typeHint: hit.hint,
        observedAt,
        confidence: hit.similarity,
        matchKind: "deterministic" as const,
        matchScore: hit.similarity,
        runId: ref.runId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: mentions.id });
  return rows.length;
}

export type AmbiguousDraft = { start: number; end: number; surface: string; hint: Hint | null; candidates: MatchCandidate[] };

/** Ambiguous spans waiting for the disambiguation; returns how many are new. */
export async function storeAmbiguous(db: Db, ref: ChunkRef, drafts: AmbiguousDraft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const rows = await db
    .insert(ambiguousMatches)
    .values(
      drafts.map((d) => ({
        documentVersionId: ref.versionId,
        chunkId: ref.chunkId,
        surface: d.surface,
        charStart: d.start,
        charEnd: d.end,
        typeHint: d.hint,
        candidates: d.candidates,
        runId: ref.runId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: ambiguousMatches.id });
  return rows.length;
}

/** The spans of the version's mentions, by chunk. */
export async function mentionSpans(db: Db, versionId: string): Promise<Map<string, Array<{ start: number; end: number }>>> {
  const rows = await db
    .select({ chunkId: mentions.chunkId, start: mentions.charStart, end: mentions.charEnd })
    .from(mentions)
    .where(eq(mentions.documentVersionId, versionId));
  const out = new Map<string, Array<{ start: number; end: number }>>();
  for (const r of rows) out.set(r.chunkId, [...(out.get(r.chunkId) ?? []), { start: r.start, end: r.end }]);
  return out;
}

/**
 * Settles the version's pending ambiguous spans that a mention of their chunk overlaps as `resolved`: the span has a
 * mention, so the disambiguation must not add a second one. Returns their ids.
 */
export async function settleCoveredAmbiguous(db: Db, versionId: string): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    update ambiguous_matches am set status = 'resolved', updated_at = now()
    where am.document_version_id = ${versionId} and am.status = 'pending'
      and exists (
        select 1 from mentions m
        where m.chunk_id = am.chunk_id and m.char_start < am.char_end and am.char_start < m.char_end
      )
    returning am.id
  `);
  return rows.map((r) => r.id);
}

export type UnmatchedRow = { nameNormalized: string; displayName: string; hint: Hint; chunkId: string; tileId: string | null };

/** Place hints without a gazetteer hit; returns how many are new. */
export async function storeUnmatched(db: Db, versionId: string, sourceId: string, drafts: UnmatchedRow[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const rows = await db
    .insert(unmatchedNames)
    .values(drafts.map((d) => ({ ...d, documentVersionId: versionId, sourceId })))
    .onConflictDoNothing()
    .returning({ id: unmatchedNames.id });
  return rows.length;
}

/** Marks the version as passed by the match with this configuration. */
export async function recordMatchPass(db: Db, versionId: string, configKey: string, runId: string | null): Promise<void> {
  await db.insert(pipelinePasses).values({ documentVersionId: versionId, stage: MATCH_PASS_STAGE, configKey, runId }).onConflictDoNothing();
}
