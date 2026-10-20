import { and, asc, desc, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { QUALITY_MEASURE_STAGE } from "@/lib/pipeline/quality-stages";
import { startRun } from "@/lib/pipeline/runs";
import { areaGeoObjectId, RunScopeNotReady } from "@/lib/pipeline/tile-scope";

// Kept apart from ./quality-stages: the job handler imports that module, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handler (rulings M6-P17, M7-P5).

export const MEASUREMENT_LABEL_MAX = 40;

/** The measurement runs of the area (any status). */
const measurementOf = (areaKey: string) =>
  sql`${runs.scopeType} = 'area' and ${runs.scopeId} = ${areaKey} and ${QUALITY_MEASURE_STAGE} = any(${runs.stages})`;

/**
 * Starts a measurement run „Messen“ for the area (spec 10): kind `stage`, scope `area` with the area key, stage
 * `quality.measure`, params `{ areaKey, label, from, to }` (ISO timestamps). `to` defaults to now, `from` to the `to` of
 * the area's previous measurement run, else to the creation of the oldest run (the start of operations). The label
 * (trimmed, 1–40 characters) is unique per area: checked with the run's insert in one transaction under an advisory
 * lock per area (ruling M7-P5), so two starts cannot take the same label. An unknown area throws `RunScopeNotReady`
 * (`unknown_area`), a taken label `measurement_label_taken`; an empty or too long label, or `from` not before `to`,
 * an Error.
 */
export async function startMeasurement(
  db: Db,
  boss: PgBoss,
  input: { areaKey: string; label: string; from?: Date; to?: Date; triggeredBy: string },
): Promise<{ id: string }> {
  const label = input.label.trim();
  if (label.length < 1 || label.length > MEASUREMENT_LABEL_MAX) throw new Error(`label must have 1–${MEASUREMENT_LABEL_MAX} characters`);
  if (!(await areaGeoObjectId(db, input.areaKey))) throw new RunScopeNotReady("unknown_area", `area ${input.areaKey} has no area geo object`);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`measure:${input.areaKey}`}))`);
    const [taken] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(measurementOf(input.areaKey), sql`${runs.params} ->> 'label' = ${label}`))
      .limit(1);
    if (taken) throw new RunScopeNotReady("measurement_label_taken", `area ${input.areaKey} has a measurement labelled ${label}`);

    const to = input.to ?? new Date();
    let from = input.from;
    if (!from) {
      const [previous] = await tx
        .select({ params: runs.params })
        .from(runs)
        .where(measurementOf(input.areaKey))
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(1);
      const previousTo = (previous?.params as Record<string, unknown> | undefined)?.to;
      if (typeof previousTo === "string") from = new Date(previousTo);
      else {
        const [oldest] = await tx.select({ createdAt: runs.createdAt }).from(runs).orderBy(asc(runs.createdAt)).limit(1);
        from = oldest?.createdAt ?? to;
      }
    }
    if (!(from.getTime() < to.getTime())) throw new Error(`the window must start before it ends (${from.toISOString()} – ${to.toISOString()})`);

    return startRun(tx, boss, {
      kind: "stage",
      scope: { type: "area", id: input.areaKey },
      stages: [QUALITY_MEASURE_STAGE],
      params: { areaKey: input.areaKey, label, from: from.toISOString(), to: to.toISOString() },
      triggeredBy: input.triggeredBy,
    });
  });
}
