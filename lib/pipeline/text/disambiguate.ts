import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  disambiguateMentionTask,
  type DisambiguateCandidate,
  type DisambiguateMentionInput,
  type DisambiguateMentionOutput,
} from "@/lib/ai/tasks/disambiguate-mention";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { ambiguousMatches, chunks, mentions, type AmbiguousStatus, type GeoObjectType } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { effectiveVersionMeta } from "@/lib/domain/mentions/classification";
import type { MatchCandidate } from "@/lib/domain/mentions/match";
import { jsonUuids } from "@/lib/domain/mentions/scope";
import type { JobData } from "@/lib/jobs/worker";
import type { BatchDeps, BatchHandlerEntry, BatchItemInput } from "@/lib/pipeline/batches";
import { submitStageJobBatch } from "./stage-batch";
import { textRunParamsSchema, textRunVersions } from "./versions";

/*
 * Stage `mentions.disambiguate` (spec 06): only the ambiguous matches of the run's versions go to the model, as message
 * batches of at most `unitsPerBatch` per job; the model sees the chunk around the marked name and the candidates with
 * type, parents and coordinate, and picks one or none. A pick becomes a mention (`match_kind model`).
 */

export const DISAMBIGUATE_STAGE = "mentions.disambiguate";
export const DISAMBIGUATE_QUEUE = "mentions.disambiguate" as const;
const SUBJECT = "ambiguous_match";

const task = disambiguateMentionTask as ModelTask<unknown, unknown>;

export type DisambiguateJob = { runId: string; stage: string; key: string; ambiguousIds: string[] };

/** Plan: the pending ambiguous matches of the run's versions, `unitsPerBatch` per job, in id order. */
export async function planDisambiguate(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const versions = await textRunVersions(db, textRunParamsSchema.parse(run.params), config);
  if (versions.length === 0) return [];
  const rows = await db
    .select({ id: ambiguousMatches.id })
    .from(ambiguousMatches)
    .where(and(inArray(ambiguousMatches.documentVersionId, versions), eq(ambiguousMatches.status, "pending")))
    .orderBy(asc(ambiguousMatches.id));
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < rows.length; i++) {
    jobs.push({ key: `disambiguate:${i}`, ambiguousIds: rows.slice(i * size, (i + 1) * size).map((r) => r.id) });
  }
  return jobs;
}

/**
 * The part of a chunk around [start, end), at most `maxChars` characters (without the marks), with the name marked as
 * `[[surface]]`.
 */
export function markedContext(text: string, start: number, end: number, maxChars: number): string {
  let from = 0;
  let to = text.length;
  if (text.length > maxChars) {
    const room = Math.max(0, maxChars - (end - start));
    from = Math.max(0, start - Math.floor(room / 2));
    to = Math.min(text.length, Math.max(end, from + maxChars));
    from = Math.max(0, Math.min(from, to - maxChars));
  }
  return `${text.slice(from, start)}[[${text.slice(start, end)}]]${text.slice(end, to)}`;
}

/** Name, type, parent chain (nearest first) and coordinate of one candidate object. */
async function candidateDetails(db: Db, geoObjectId: string, n: number): Promise<DisambiguateCandidate> {
  const { rows } = await db.execute<{ depth: number; name: string | null; type: GeoObjectType; lon: number; lat: number }>(sql`
    with recursive up(id, parent_id, depth) as (
      select o.id, o.parent_id, 0 from geo_objects o where o.id = ${geoObjectId}
      union all
      select p.id, p.parent_id, up.depth + 1 from geo_objects p join up on p.id = up.parent_id where up.depth < 10
    )
    select up.depth, ${displayNameSql(sql`up.id`)} as name, o.type, ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat
    from up join geo_objects o on o.id = up.id
    order by up.depth
  `);
  const self = rows[0];
  if (!self) throw new Error(`candidate geo object ${geoObjectId} does not exist`);
  return {
    n,
    name: self.name ?? "(unnamed)",
    type: self.type,
    parents: rows.slice(1).flatMap((r) => (r.name ? [r.name] : [])),
    lon: Number(self.lon),
    lat: Number(self.lat),
  };
}

/** The task input of an ambiguous match: the marked chunk context and its candidates, numbered from 1 in stored order. */
export async function disambiguationInput(db: Db, ambiguousId: string, config: AppConfig = getConfig()): Promise<DisambiguateMentionInput> {
  const [row] = await db
    .select({ match: ambiguousMatches, text: chunks.text })
    .from(ambiguousMatches)
    .innerJoin(chunks, eq(chunks.id, ambiguousMatches.chunkId))
    .where(eq(ambiguousMatches.id, ambiguousId));
  if (!row) throw new Error(`ambiguous match ${ambiguousId} does not exist`);
  const m = row.match;
  const stored = m.candidates as MatchCandidate[];
  const candidates: DisambiguateCandidate[] = [];
  for (const [i, c] of stored.entries()) candidates.push(await candidateDetails(db, c.geoObjectId, i + 1));
  return {
    chunk: markedContext(row.text, m.charStart, m.charEnd, config.mentions.disambiguationContextChars),
    surface: m.surface,
    candidates,
  };
}

/**
 * Applies the model's answer to an ambiguous match, once: a `choice` of one of its candidates becomes a mention
 * (`match_kind model`, `confidence` from the answer, `match_score` the candidate's similarity) and marks the match
 * `resolved`; 0 or a number outside the candidates marks it `none`. A match already decided keeps its first decision,
 * so a repeated answer changes nothing.
 */
export async function applyDisambiguation(
  db: Db,
  ambiguousId: string,
  out: DisambiguateMentionOutput,
  meta: { model: string; promptVersion: number; runId: string | null },
): Promise<"mention" | "none"> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(ambiguousMatches).where(eq(ambiguousMatches.id, ambiguousId)).for("update");
    if (!row) throw new Error(`ambiguous match ${ambiguousId} does not exist`);
    if (row.status !== "pending") return row.status === "resolved" ? "mention" : "none";
    const candidates = row.candidates as MatchCandidate[];
    const chosen = Number.isInteger(out.choice) && out.choice >= 1 ? candidates[out.choice - 1] : undefined;
    const decide = (status: AmbiguousStatus) =>
      tx.update(ambiguousMatches).set({ status, updatedAt: sql`now()` }).where(and(eq(ambiguousMatches.id, ambiguousId), eq(ambiguousMatches.status, "pending")));
    if (!chosen) {
      await decide("none");
      return "none";
    }
    const version = await effectiveVersionMeta(tx, row.documentVersionId);
    await tx
      .insert(mentions)
      .values({
        documentVersionId: row.documentVersionId,
        chunkId: row.chunkId,
        geoObjectId: chosen.geoObjectId,
        surface: row.surface,
        charStart: row.charStart,
        charEnd: row.charEnd,
        typeHint: row.typeHint,
        observedAt: version.observedAt,
        confidence: Math.min(1, Math.max(0, out.confidence)),
        matchKind: "model",
        matchScore: chosen.similarity,
        model: meta.model,
        promptVersion: meta.promptVersion,
        runId: meta.runId,
      })
      .onConflictDoNothing();
    await decide("resolved");
    return "mention";
  });
}

/** Of `ids`, the matches still pending, in the given order. */
async function pendingMatches(db: Db, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    select id from ambiguous_matches where id in ${jsonUuids(ids)} and status = 'pending'
  `);
  const open = new Set(rows.map((r) => r.id));
  return ids.filter((id) => open.has(id));
}

/**
 * One disambiguation job: its pending matches go out as one message batch, sized to the budget headroom (see
 * `submitStageJobBatch`). Never call it inside a transaction.
 */
export async function disambiguateMatches(
  db: Db,
  deps: BatchDeps,
  job: DisambiguateJob,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  return submitStageJobBatch(db, deps, {
    task,
    queue: DISAMBIGUATE_QUEUE,
    job,
    subjectIds: job.ambiguousIds,
    open: (ids) => pendingMatches(db, ids),
    inputs: async (ids) => {
      const items: BatchItemInput[] = [];
      for (const id of ids) items.push({ subjectType: SUBJECT, subjectId: id, input: await disambiguationInput(db, id, config) });
      return items;
    },
    remainderData: (ids) => ({ ambiguousIds: ids }),
  });
}

/** Batch handler of `disambiguate-mention`: applies one answer. */
export const disambiguationBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item) => {
    const out = disambiguateMentionTask.output.parse(item.output);
    await applyDisambiguation(db, item.subjectId, out, {
      model: item.batch.model,
      promptVersion: item.batch.promptVersion,
      runId: item.batch.runId,
    });
  },
};
