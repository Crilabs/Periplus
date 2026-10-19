import { eq, sql } from "drizzle-orm";
import { getConfig, getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { changeEvents, evaluationProfiles, profiles, reviewTasks } from "@/lib/db/schema";
import { createReviewTask } from "@/lib/domain/review";
import { latestProfile } from "@/lib/domain/timeline";
import { buildProfile } from "./build";
import { diffProfiles, type EventDraft } from "./changes";
import { loadContext, loadDerivedInputs, loadInputs, type LoadInputsOptions } from "./inputs";

/*
 * Consolidation of one geo object (spec 07 "Ablauf"): load, build, compare with the valid profile, and write a new
 * version only on change, its change events and the review tasks.
 */

export type ConsolidateOptions = {
  runId?: string;
  /** The run date `YYYY-MM-DD`; default the UTC date the run was created, else today (UTC). */
  today?: string;
  /** `evaluation`: a candidate rules version into `evaluation_profiles`, never into profiles or the change feed. */
  mode?: "regular" | "evaluation";
  /** The rules version (default the active one); required for `evaluation`. */
  rulesVersion?: string;
};

export type ConsolidateResult = {
  status: "created" | "unchanged" | "skipped" | "evaluated";
  version: number | null;
  /** Change events written. */
  events: number;
  /** Review tasks opened (an open task of the same kind and subject is reused, not counted). */
  tasks: number;
};

const SUBJECT_TYPE = "profile_attribute";

async function runDate(db: Db, opts: ConsolidateOptions): Promise<string> {
  if (opts.today) return opts.today;
  if (opts.runId) {
    const { rows } = await db.execute<{ day: string }>(
      sql`select (created_at at time zone 'UTC')::date::text as day from runs where id = ${opts.runId}`,
    );
    if (rows[0]) return rows[0].day;
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Consolidates one geo object in one transaction under `pg_advisory_xact_lock(hashtext('profile:' || id))`, the only
 * place that writes profiles: the lock serializes versions and the `valid_from` order (trigger
 * `profiles_valid_from_monotonic`, ruling M5-A-R2). Lock order (ruling M5-P9): the profile lock first, then review
 * task rows; review decisions on `profile_attribute` tasks never take the profile lock.
 *
 * Steps: context (`null` → `skipped`), inputs, derived inputs, `buildProfile`, `latestProfile`, `diffProfiles`.
 * - `regular`: on `versionNeeded` a new version (previous + 1, `valid_from` = the later of the run date and the
 *   previous `valid_from`, `run_id`); the events carry the new or else the existing version; each task draft opens an
 *   `uncertain_change` / `conflict` task on `<geoObjectId>:<attribute>` (context with `key` and `geoObjectId`) and
 *   writes its event only when the task is new. An open task of the same kind and subject (one per subject, ruling
 *   M5-P9) is locked and gets the newest draft's context when its key differs, without a second event.
 * - `evaluation`: upserts `evaluation_profiles (runId, geoObjectId)` with `opts.rulesVersion`: the profile as a regular
 *   run would write it (after the comparison with the valid profile, so uncertain values stay); no profile, event or
 *   task.
 */
export async function consolidateGeo(db: Db, geoObjectId: string, opts: ConsolidateOptions = {}): Promise<ConsolidateResult> {
  const mode = opts.mode ?? "regular";
  if (mode === "evaluation" && (!opts.runId || !opts.rulesVersion)) {
    throw new Error("an evaluation consolidation needs runId and rulesVersion");
  }
  const appConfig = getConfig();
  const cfg = getConsolidationConfig(opts.rulesVersion);
  const schemaVersion = appConfig.factSchema.version;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`profile:${geoObjectId}`}))`);
    const today = await runDate(tx, opts);
    const context = await loadContext(tx, geoObjectId, cfg, today);
    if (context === null) return { status: "skipped", version: null, events: 0, tasks: 0 };

    const loadOpts: LoadInputsOptions = { cfg, schemaVersion, appConfig, today };
    const { inputs } = await loadInputs(tx, geoObjectId, loadOpts);
    const derived = await loadDerivedInputs(tx, geoObjectId, context, loadOpts);
    const built = buildProfile({ inputs, context, derived, today, cfg, schemaVersion, rulesVersion: cfg.version });
    const prev = await latestProfile(tx, geoObjectId);
    const diff = diffProfiles(prev, built, { cfg, level: context.level, context, today });
    const { profile } = diff;

    if (mode === "evaluation") {
      const row = {
        runId: opts.runId!,
        geoObjectId,
        rulesVersion: cfg.version,
        factSchemaVersion: schemaVersion,
        attributes: profile.attributes,
        provenance: profile.provenance,
        contentHash: profile.contentHash,
      };
      await tx
        .insert(evaluationProfiles)
        .values(row)
        .onConflictDoUpdate({
          target: [evaluationProfiles.runId, evaluationProfiles.geoObjectId],
          set: { rulesVersion: row.rulesVersion, factSchemaVersion: row.factSchemaVersion, attributes: row.attributes, provenance: row.provenance, contentHash: row.contentHash, createdAt: sql`now()` },
        });
      return { status: "evaluated", version: null, events: 0, tasks: 0 };
    }

    let version = prev?.version ?? null;
    if (diff.versionNeeded) {
      version = (prev?.version ?? 0) + 1;
      await tx.insert(profiles).values({
        geoObjectId,
        version,
        validFrom: prev && prev.validFrom > today ? prev.validFrom : today,
        attributes: profile.attributes,
        provenance: profile.provenance,
        conflicts: profile.conflicts,
        gaps: profile.gaps,
        sourcesCount: profile.sourcesCount,
        documentsCount: profile.documentsCount,
        confidence: profile.confidence,
        contentHash: profile.contentHash,
        factSchemaVersion: profile.factSchemaVersion,
        rulesVersion: profile.rulesVersion,
        runId: opts.runId ?? null,
      });
    }

    const events: EventDraft[] = [...diff.events];
    let opened = 0;
    for (const draft of diff.tasks) {
      const taskContext = { ...draft.context, key: draft.key, geoObjectId };
      const task = await createReviewTask(tx, {
        kind: draft.kind,
        subjectType: SUBJECT_TYPE,
        subjectId: `${geoObjectId}:${draft.attribute}`,
        context: taskContext,
        priority: draft.priority,
      });
      if (task.created) {
        opened++;
        if (draft.event) events.push({ ...draft.event, details: { ...draft.event.details, taskId: task.id } });
        continue;
      }
      const [open] = await tx
        .select({ context: reviewTasks.context })
        .from(reviewTasks)
        .where(eq(reviewTasks.id, task.id))
        .for("update");
      if ((open?.context as { key?: unknown } | undefined)?.key !== draft.key) {
        await tx.update(reviewTasks).set({ context: taskContext, priority: draft.priority }).where(eq(reviewTasks.id, task.id));
      }
    }

    if (events.length > 0) {
      await tx.insert(changeEvents).values(
        events.map((e) => ({
          geoObjectId,
          profileVersion: version,
          type: e.type,
          attribute: e.attribute,
          oldValue: e.oldValue,
          newValue: e.newValue,
          severity: e.severity,
          details: e.details,
          runId: opts.runId ?? null,
        })),
      );
    }
    return { status: diff.versionNeeded ? "created" : "unchanged", version, events: events.length, tasks: opened };
  });
}
