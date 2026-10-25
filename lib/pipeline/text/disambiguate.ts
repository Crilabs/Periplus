import { and, eq, inArray, sql } from "drizzle-orm";
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
import { jsonUuids } from "@/lib/domain/research/util/json-uuids";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import type { BatchDeps, BatchHandlerEntry, BatchItemInput } from "@/lib/pipeline/batches";
import { submitStageJobBatch } from "@/lib/pipeline/stage-batch";
import { frozenRunVersions } from "./versions";

/*
 * Stage `mentions.disambiguate` (spec 06): only the ambiguous matches of the run's versions go to the model, as message
 * batches of at most `unitsPerBatch` per job; the model sees the chunk around the marked name and the candidates with
 * type, parents and coordinate, and picks one or none. A pick becomes a mention (`match_kind model`).
 */

export const DISAMBIGUATE_STAGE = "mentions.disambiguate";
export const DISAMBIGUATE_QUEUE = "mentions.disambiguate" as const;
const SUBJECT = "ambiguous_match";

const task = disambiguateMentionTask as ModelTask<unknown, unknown>;

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.text.disambiguate"));

export type DisambiguateJob = { runId: string; stage: string; key: string; ambiguousIds: string[] };

/**
 * Plan: the pending ambiguous matches of the run's versions (frozen set, ruling M4-E-R2), `unitsPerBatch` per job, in
 * id order. The plan claims them for this run in its transaction (like ruling M4-P17): a match is planned only when it
 * belongs to this run, to no run, or to a run that is no longer active, and it then belongs to this run. Two
 * overlapping text runs therefore never both send (and pay for) the same match; a match of an active other run is left
 * to that run.
 */
export async function planDisambiguate(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const versions = await frozenRunVersions(db, run.params);
  if (versions.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    update ambiguous_matches am set run_id = ${run.id}, updated_at = now()
    where am.document_version_id in ${jsonUuids(versions)}
      and am.status = 'pending'
      and (
        am.run_id is null or am.run_id = ${run.id}
        or not exists (select 1 from runs r where r.id = am.run_id and r.status in ('queued', 'running'))
      )
    returning am.id
  `);
  const ids = rows.map((r) => r.id).sort();
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < ids.length; i++) {
    jobs.push({ key: `disambiguate:${i}`, ambiguousIds: ids.slice(i * size, (i + 1) * size) });
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

type CandidateRow = { id: string; depth: number; name: string | null; type: GeoObjectType; lon: number; lat: number };

/** Name, type, parent chain (nearest first) and coordinate of the given objects, in one query (also for extraction). */
export async function candidateDetails(db: Db, geoObjectIds: string[]): Promise<Map<string, Omit<DisambiguateCandidate, "n">>> {
  const out = new Map<string, Omit<DisambiguateCandidate, "n">>();
  if (geoObjectIds.length === 0) return out;
  const { rows } = await db.execute<CandidateRow>(sql`
    with recursive up(root, id, parent_id, depth) as (
      select o.id, o.id, o.parent_id, 0 from geo_objects o where o.id in ${jsonUuids(geoObjectIds)}
      union all
      select up.root, p.id, p.parent_id, up.depth + 1 from geo_objects p join up on p.id = up.parent_id where up.depth < 10
    )
    select up.root as id, up.depth, ${displayNameSql(sql`up.id`)} as name, o.type, ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat
    from up join geo_objects o on o.id = up.id
    order by up.root, up.depth
  `);
  const byRoot = new Map<string, CandidateRow[]>();
  for (const r of rows) byRoot.set(r.id, [...(byRoot.get(r.id) ?? []), r]);
  for (const [id, chain] of byRoot) {
    const self = chain[0]!;
    out.set(id, {
      name: self.name ?? "(unnamed)",
      type: self.type,
      parents: chain.slice(1).flatMap((r) => (r.name ? [r.name] : [])),
      lon: Number(self.lon),
      lat: Number(self.lat),
    });
  }
  return out;
}

/**
 * The task inputs of ambiguous matches (the marked chunk context and the candidates, numbered from 1 in stored order),
 * with two queries for all of them. A match that does not exist, or one of whose candidates does not exist, is left
 * out and logged.
 */
export async function disambiguationInputs(db: Db, ambiguousIds: string[], config: AppConfig = getConfig()): Promise<Map<string, DisambiguateMentionInput>> {
  const out = new Map<string, DisambiguateMentionInput>();
  if (ambiguousIds.length === 0) return out;
  const rows = await db
    .select({ match: ambiguousMatches, text: chunks.text })
    .from(ambiguousMatches)
    .innerJoin(chunks, eq(chunks.id, ambiguousMatches.chunkId))
    .where(inArray(ambiguousMatches.id, ambiguousIds));
  const details = await candidateDetails(db, [...new Set(rows.flatMap((r) => (r.match.candidates as MatchCandidate[]).map((c) => c.geoObjectId)))]);
  const found = new Set(rows.map((r) => r.match.id));
  for (const id of ambiguousIds) if (!found.has(id)) getLog().warn({ ambiguousId: id }, "ambiguous match missing, left out of the batch");
  for (const { match: m, text } of rows) {
    const stored = m.candidates as MatchCandidate[];
    const missing = stored.filter((c) => !details.has(c.geoObjectId)).map((c) => c.geoObjectId);
    if (missing.length > 0) {
      getLog().warn({ ambiguousId: m.id, missing }, "candidate geo object missing, match left out of the batch");
      continue;
    }
    out.set(m.id, {
      chunk: markedContext(text, m.charStart, m.charEnd, config.mentions.disambiguationContextChars),
      surface: m.surface,
      candidates: stored.map((c, i) => ({ n: i + 1, ...details.get(c.geoObjectId)! })),
    });
  }
  return out;
}

/** The task input of one ambiguous match (`disambiguationInputs`); throws when it cannot be built. */
export async function disambiguationInput(db: Db, ambiguousId: string, config: AppConfig = getConfig()): Promise<DisambiguateMentionInput> {
  const input = (await disambiguationInputs(db, [ambiguousId], config)).get(ambiguousId);
  if (!input) throw new Error(`ambiguous match ${ambiguousId} or one of its candidates does not exist`);
  return input;
}

/**
 * Applies the model's answer to an ambiguous match, once: a `choice` of one of its candidates becomes a mention
 * (`match_kind model`, `confidence` from the answer, `match_score` the candidate's similarity) and marks the match
 * `resolved`; 0, a number outside the candidates, or a candidate that is no longer valid (ended or merged since the
 * match) marks it `none`. A match already decided keeps its first decision, so a repeated answer changes nothing.
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
    let chosen = Number.isInteger(out.choice) && out.choice >= 1 ? candidates[out.choice - 1] : undefined;
    const decide = (status: AmbiguousStatus) =>
      tx.update(ambiguousMatches).set({ status, updatedAt: sql`now()` }).where(and(eq(ambiguousMatches.id, ambiguousId), eq(ambiguousMatches.status, "pending")));
    if (chosen && !(await isValidObject(tx, chosen.geoObjectId))) {
      getLog().info({ ambiguousId, geoObjectId: chosen.geoObjectId }, "chosen candidate no longer valid, match marked none");
      chosen = undefined;
    }
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

/** Whether the geo object is valid today and not merged into another. */
async function isValidObject(db: Db, geoObjectId: string): Promise<boolean> {
  const { rows } = await db.execute<{ ok: boolean }>(sql`
    select true as ok from geo_objects o
    where o.id = ${geoObjectId} and o.merged_into_id is null
      and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
  `);
  return rows.length > 0;
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
    queue: DISAMBIGUATE_QUEUE as never, // queue dropped in N6; module is deleted in Task 4
    job,
    subjectIds: job.ambiguousIds,
    open: (ids) => pendingMatches(db, ids),
    inputs: async (ids) => {
      const inputs = await disambiguationInputs(db, ids, config);
      const items: BatchItemInput[] = [];
      for (const id of ids) {
        const input = inputs.get(id);
        if (input) items.push({ subjectType: SUBJECT, subjectId: id, input });
      }
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
