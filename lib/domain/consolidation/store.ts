import { eq, sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { changeEvents, evaluationProfiles, profiles, reviewTasks } from "@/lib/db/schema";
import { canonicalJson } from "@/lib/domain/facts/schema";
import type { CategorySelection } from "@/lib/domain/highlights/select";
import { deleteHighlightSelections, replaceHighlightSelections, type HighlightsValue } from "@/lib/domain/highlights/selections";
import { createReviewTask, OpenTaskVanished } from "@/lib/domain/review";
import { runDate as runDateOf } from "@/lib/domain/runs";
import { latestProfile } from "@/lib/domain/timeline";
import { createLogger } from "@/lib/logger";
import { consolidationConfigFor } from "./active-rules";
import { buildProfile, highlightsAttribute, profileContentHash } from "./build";
import { diffProfiles, type EventDraft, type TaskDraft } from "./changes";
import { profileConfidence } from "./derived/confidence";
import { candidateAppConfig, highlightInputs, loadContext, loadDerivedInputs, loadInputs, type ExtractionCandidate, type LoadInputsOptions } from "./inputs";
import { dismissTasks, lockOpenTasks, subjectPrefix } from "@/lib/domain/review/task-locks";
import { applyAutoStatus } from "@/lib/domain/places/auto-status";

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
  /** The rules version (default the active one, `activeRulesVersion`); required for `evaluation`. */
  rulesVersion?: string;
  /**
   * An extraction candidate (only with `evaluation`, else an Error): the active extraction run is the one of this model
   * and prompt version (ruling M7-P11, `candidateAppConfig`).
   */
  extraction?: ExtractionCandidate;
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

/** The run date: `opts.today`, else the UTC date the run was created (an unknown run id is an error), else today (UTC). */
async function runDate(db: Db, opts: ConsolidateOptions): Promise<string> {
  if (opts.today) return opts.today;
  if (opts.runId) return runDateOf(db, opts.runId);
  return new Date().toISOString().slice(0, 10);
}

/** `"<kind>:<key>"` of the decided `conflict` / `uncertain_change` tasks of the object, read now (after the locks). */
async function decidedTaskKeys(tx: Db, geoObjectId: string): Promise<Set<string>> {
  const prefix = subjectPrefix(geoObjectId);
  const { rows } = await tx.execute<{ kind: string; key: string }>(sql`
    select kind::text as kind, context->>'key' as key from review_tasks
    where kind in ('conflict', 'uncertain_change') and left(subject_id, ${prefix.length}) = ${prefix}
      and status = 'decided' and context ? 'key'
  `);
  return new Set(rows.map((r) => `${r.kind}:${r.key}`));
}

/**
 * Opens the draft's task. Under the profile lock and with no open task of its kind and subject left locked, the
 * insert normally creates; should it meet an open task anyway (`created false`) or one that vanished, it is retried
 * once and then skipped (logged): the next run drafts it again.
 */
async function openDraftTask(tx: Db, draft: TaskDraft, subjectId: string, context: Record<string, unknown>): Promise<{ id: string; created: boolean } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const task = await createReviewTask(tx, { kind: draft.kind, subjectType: SUBJECT_TYPE, subjectId, context, priority: draft.priority });
      if (task.created) return task;
      const [open] = await tx
        .select({ id: reviewTasks.id })
        .from(reviewTasks)
        .where(sql`${reviewTasks.id} = ${task.id} and ${reviewTasks.status} = 'open'`)
        .for("update");
      if (open) {
        await tx.update(reviewTasks).set({ context, priority: draft.priority }).where(eq(reviewTasks.id, open.id));
        return { id: open.id, created: false };
      }
    } catch (e) {
      if (!(e instanceof OpenTaskVanished)) throw e;
    }
  }
  createLogger("consolidation").warn({ kind: draft.kind, subjectId, key: draft.key }, "review task draft skipped: its open task changed during the run");
  return null;
}

/**
 * Consolidates one geo object in one transaction under `pg_advisory_xact_lock(hashtext('profile:' || id))`, the only
 * place that writes profiles: the lock serializes versions and the `valid_from` order (trigger
 * `profiles_valid_from_monotonic`, ruling M5-A-R2). Lock order (ruling M5-P9): the profile lock first, then review
 * task rows; review decisions on `profile_attribute` tasks never take the profile lock.
 *
 * Must run in READ COMMITTED (asserted): each statement after the lock must see what the previous holder committed;
 * under REPEATABLE READ the snapshot of the first statement would hide the winner's version, and a caller's outer
 * `repeatable read` transaction would defeat the lock (ruling M5-F-R2).
 *
 * Steps: context (`null` → `skipped`; a regular run then dismisses the object's open `conflict` / `uncertain_change`
 * tasks with `context.dismissedReason` `object_ended`: a merged or rejected object keeps its last profile as history,
 * never delivered, final review M-6), inputs, derived inputs, (regular runs of a place) the kind switch by evidence
 * (`applyAutoStatus`, spec 17; the context then carries the place as changed), `buildProfile`,
 * `latestProfile`, `diffProfiles`.
 * - `regular`: on `versionNeeded` a new version (previous + 1, `valid_from` = the later of the run date and the
 *   previous `valid_from`, `run_id`); the events carry the new or else the existing version (an attribute event
 *   without a new version is an error). Review tasks (ruling M5-P9, M5-F-R2, M5-F-R3 I-4):
 *   - the object's open `conflict` / `uncertain_change` tasks are locked first (by id), then the decided keys are read
 *     again, so a decision committed during the run is seen: a draft whose key is decided now is dropped;
 *   - a draft with an open task of its kind and subject updates that task's context and priority when they differ
 *     (the newest draft; no second event);
 *   - otherwise the draft opens a task on `<geoObjectId>:<attribute>` (context with `key` and `geoObjectId`) and
 *     writes its event;
 *   - an open task no draft of this run matches is dismissed (`context.dismissedReason` `superseded`).
 * - `regular`, a place: its `highlight_selections` rows are replaced by the `derived.highlights` of the profile as
 *   stored (new or kept version, spec 16); an object without a valid place (ended, merged, rejected) loses its rows.
 * - `evaluation`: upserts `evaluation_profiles (runId, geoObjectId)` with `opts.rulesVersion`: the profile as a regular
 *   run would write it (after the comparison with the valid profile, so uncertain values stay); no profile, event or
 *   task.
 */
export async function consolidateGeo(db: Db, geoObjectId: string, opts: ConsolidateOptions = {}): Promise<ConsolidateResult> {
  const mode = opts.mode ?? "regular";
  if (mode === "evaluation" && (!opts.runId || !opts.rulesVersion)) {
    throw new Error("an evaluation consolidation needs runId and rulesVersion");
  }
  if (opts.extraction && mode !== "evaluation") throw new Error("an extraction candidate is consolidated in evaluation mode only");
  const appConfig = opts.extraction ? candidateAppConfig(getConfig(), opts.extraction) : getConfig();
  const cfg = await consolidationConfigFor(db, opts.rulesVersion);
  const schemaVersion = appConfig.factSchema.version;

  return db.transaction(async (tx) => {
    const { rows: isolation } = await tx.execute<{ level: string }>(sql`select current_setting('transaction_isolation') as level`);
    if (isolation[0]?.level !== "read committed") {
      throw new Error(`consolidateGeo must run in READ COMMITTED, not ${isolation[0]?.level}`);
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`profile:${geoObjectId}`}))`);
    const today = await runDate(tx, opts);
    const context = await loadContext(tx, geoObjectId, cfg, today);
    if (context === null) {
      // an ended, merged or rejected object: its open profile tasks are moot, its last profile stays as history
      if (mode === "regular") {
        await dismissTasks(tx, [...(await lockOpenTasks(tx, geoObjectId)).values()].map((t) => t.id), "object_ended");
        // an ended, merged or rejected place selects no highlights any more (spec 16)
        await deleteHighlightSelections(tx, geoObjectId);
      }
      return { status: "skipped", version: null, events: 0, tasks: 0 };
    }

    const loadOpts: LoadInputsOptions = { cfg, schemaVersion, appConfig, today };
    const { inputs } = await loadInputs(tx, geoObjectId, loadOpts);
    const derived = await loadDerivedInputs(tx, geoObjectId, context, loadOpts);
    if (mode === "regular" && context.place) {
      // spec 17: kind switch by evidence, so this run's profile carries it (the status is set by the research confirmation, plan N2)
      const auto = await applyAutoStatus(tx, context, inputs, appConfig, new Date(), { rules: cfg, today });
      if (auto.place) context.place = { ...context.place, ...auto.place };
    }
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

    if (!diff.versionNeeded && diff.events.length > 0) {
      throw new Error(`consolidation of ${geoObjectId}: ${diff.events.length} change events without a new version`);
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

    if (context.level === "place" && context.place && version !== null) {
      // the selection of the profile as stored (spec 16), replaced on every regular consolidation of the place
      await replaceHighlightSelections(
        tx,
        geoObjectId,
        version,
        profile.attributes["derived.highlights"] as HighlightsValue | undefined,
        profile.provenance["derived.highlights"]?.derivedFrom as Partial<Record<string, CategorySelection>> | undefined,
      );
    } else {
      // no valid place (any more) on this object, e.g. its place row ended: it selects nothing
      await deleteHighlightSelections(tx, geoObjectId);
    }

    const events: EventDraft[] = [...diff.events];
    let opened = 0;
    const openTasks = await lockOpenTasks(tx, geoObjectId);
    const decided = await decidedTaskKeys(tx, geoObjectId);
    const matched = new Set<string>();
    for (const draft of diff.tasks) {
      if (decided.has(`${draft.kind}:${draft.key}`)) continue;
      const subjectId = `${geoObjectId}:${draft.attribute}`;
      const taskContext = { ...draft.context, key: draft.key, geoObjectId };
      const open = openTasks.get(`${draft.kind}:${draft.attribute}`);
      if (open) {
        matched.add(open.id);
        if (canonicalJson(open.context) !== canonicalJson(taskContext)) {
          await tx.update(reviewTasks).set({ context: taskContext, priority: draft.priority }).where(eq(reviewTasks.id, open.id));
        }
        continue;
      }
      const task = await openDraftTask(tx, draft, subjectId, taskContext);
      if (!task?.created) continue;
      opened++;
      if (draft.event) events.push({ ...draft.event, details: { ...draft.event.details, taskId: task.id } });
    }
    await dismissTasks(tx, [...openTasks.values()].filter((t) => !matched.has(t.id)).map((t) => t.id), "superseded");

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

/**
 * Re-selection of a place's highlights only (spec 16 „Aktualität“, final review C1): a place within reach of a POI of a
 * run, outside the run's own targets (`reselectionTargets`), gets its selection computed again, not a full
 * consolidation. Under the profile lock in READ COMMITTED, like `consolidateGeo`:
 * - skipped: no valid place on the object (its selection rows go, as in `consolidateGeo`), rules without `highlights`,
 *   no profile yet or a newest profile of another rules version (its next consolidation selects in full);
 * - the same `derived.highlights` value (ids and level per category) as the newest profile: no version, its selection
 *   rows are refreshed (`unchanged`);
 * - another value: a new version (previous + 1, `valid_from` as in `consolidateGeo`, `run_id`) that is the newest
 *   profile with only `derived.highlights` replaced (or removed), confidence and content hash recomputed, and its
 *   selection rows (`created`). No change event and no review task: `consolidateGeo` writes none for the attribute
 *   either.
 */
export async function reselectHighlights(
  db: Db,
  geoObjectId: string,
  opts: Pick<ConsolidateOptions, "runId" | "today" | "rulesVersion"> = {},
): Promise<ConsolidateResult> {
  const skipped: ConsolidateResult = { status: "skipped", version: null, events: 0, tasks: 0 };
  const appConfig = getConfig();
  const cfg = await consolidationConfigFor(db, opts.rulesVersion);
  if (!cfg.highlights) return skipped;
  return db.transaction(async (tx) => {
    const { rows: isolation } = await tx.execute<{ level: string }>(sql`select current_setting('transaction_isolation') as level`);
    if (isolation[0]?.level !== "read committed") {
      throw new Error(`reselectHighlights must run in READ COMMITTED, not ${isolation[0]?.level}`);
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`profile:${geoObjectId}`}))`);
    const today = await runDate(tx, opts);
    const context = await loadContext(tx, geoObjectId, cfg, today);
    if (context === null || context.level !== "place" || !context.place) {
      await deleteHighlightSelections(tx, geoObjectId);
      return skipped;
    }
    const prev = await latestProfile(tx, geoObjectId);
    if (!prev || prev.rulesVersion !== cfg.version) return skipped;

    const inputs = await highlightInputs(tx, geoObjectId, { cfg, schemaVersion: appConfig.factSchema.version, appConfig, today });
    const next = highlightsAttribute(inputs, cfg);
    const derivedFrom = next?.provenance.derivedFrom as Partial<Record<string, CategorySelection>> | undefined;
    if (canonicalJson(prev.attributes["derived.highlights"] ?? null) === canonicalJson(next?.value ?? null)) {
      await replaceHighlightSelections(tx, geoObjectId, prev.version, next?.value as HighlightsValue | undefined, derivedFrom);
      return { status: "unchanged", version: prev.version, events: 0, tasks: 0 };
    }

    const attributes = { ...prev.attributes };
    const provenance = { ...prev.provenance };
    delete attributes["derived.highlights"];
    delete provenance["derived.highlights"];
    if (next) {
      attributes["derived.highlights"] = next.value;
      provenance["derived.highlights"] = next.provenance;
    }
    const version = prev.version + 1;
    await tx.insert(profiles).values({
      geoObjectId,
      version,
      validFrom: prev.validFrom > today ? prev.validFrom : today,
      attributes,
      provenance,
      conflicts: prev.conflicts,
      gaps: prev.gaps,
      sourcesCount: prev.sourcesCount,
      documentsCount: prev.documentsCount,
      confidence: profileConfidence(provenance, cfg),
      contentHash: profileContentHash({ attributes, provenance, conflicts: prev.conflicts }),
      factSchemaVersion: prev.factSchemaVersion,
      rulesVersion: prev.rulesVersion,
      runId: opts.runId ?? null,
    });
    await replaceHighlightSelections(tx, geoObjectId, version, next?.value as HighlightsValue | undefined, derivedFrom);
    return { status: "created", version, events: 0, tasks: 0 };
  });
}
