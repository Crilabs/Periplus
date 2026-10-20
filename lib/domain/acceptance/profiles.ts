import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import type { AttributeProvenance } from "@/lib/domain/consolidation/types";
import { levelFor } from "@/lib/domain/facts/levels";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { profileAsOf } from "@/lib/domain/timeline";

/*
 * M5 acceptance check of the profiles (spec 07 "jedes bestätigte Pilot-Geo-Objekt hat ein Profil; Herkunft je
 * Attribut; Profil zum Datum abrufbar"), per area. Split into the query `profileStats` and the pure verdict
 * `assessProfiles` (ruling M5-P20), so the verdict is tested without the shared test database.
 */

/** Levels whose valid objects need a profile without a place; level `place` needs a confirmed place. */
const OBJECT_LEVELS: FactLevel[] = ["area", "island", "cape_strait", "poi"];

export type ProfileObjectStats = {
  geoObjectId: string;
  name: string | null;
  level: FactLevel;
  /** Newest profile version, null without a profile. */
  version: number | null;
  /**
   * Attributes of the newest version with a value but without provenance, without a rule, or (origin `text`,
   * `computed`, `review`) citing no fact, computation or POI.
   */
  attributesWithoutProvenance: string[];
  /** Summary of the newest version: an `ok` row, else an `empty` row, else none. */
  summary: "ok" | "empty" | null;
};

/**
 * One `profileAsOf` probe: for an object with versions on at least two dates, the day before the second date must
 * give the highest version of the first date (version 1 when it is alone on that day).
 */
export type AsOfProbe = { geoObjectId: string; date: string; expectedVersion: number; gotVersion: number | null };

export type ProfileStats = {
  objects: ProfileObjectStats[];
  /**
   * Open review tasks `conflict` / `uncertain_change` of these objects, subject type `profile_attribute` only:
   * „Eintrag entfernen“ writes immediately decided `uncertain_change` tasks of subject type `profile_entry`, which
   * are no profile uncertainty (ruling M5-I-R2 M-3).
   */
  openConflicts: number;
  openUncertain: number;
  asOfProbes: AsOfProbe[];
};

export type ProfilesCheck = {
  objects: number;
  withProfile: number;
  missing: Array<{ geoObjectId: string; name: string | null; level: FactLevel }>;
  /** Geo object ids whose newest profile has an attribute without provenance, rule or cited input. */
  withoutProvenance: string[];
  openConflicts: number;
  openUncertain: number;
  summaries: { ok: number; empty: number };
  /** Every `profileAsOf` probe gave the expected version (true without an object with two dates). */
  asOfCheck: boolean;
};

const byName = (a: { name: string | null; geoObjectId: string }, b: { name: string | null; geoObjectId: string }) =>
  (a.name ?? "").localeCompare(b.name ?? "") || a.geoObjectId.localeCompare(b.geoObjectId);

/** The check's verdict on the collected numbers (pure). */
export function assessProfiles(stats: ProfileStats): ProfilesCheck {
  const objects = [...stats.objects].sort(byName);
  return {
    objects: objects.length,
    withProfile: objects.filter((o) => o.version !== null).length,
    missing: objects.filter((o) => o.version === null).map((o) => ({ geoObjectId: o.geoObjectId, name: o.name, level: o.level })),
    withoutProvenance: objects.filter((o) => o.attributesWithoutProvenance.length > 0).map((o) => o.geoObjectId),
    openConflicts: stats.openConflicts,
    openUncertain: stats.openUncertain,
    summaries: {
      ok: objects.filter((o) => o.summary === "ok").length,
      empty: objects.filter((o) => o.summary === "empty").length,
    },
    asOfCheck: stats.asOfProbes.every((p) => p.gotVersion === p.expectedVersion),
  };
}

/** Why the check fails (empty: it passes). Open conflicts, uncertain changes and empty summaries are counted, not failed. */
export function profileCheckFailures(check: ProfilesCheck): string[] {
  const failures: string[] = [];
  // an area without objects (gazetteer not built, no coast tiles) would pass on nothing (bundle J review M-1)
  if (check.objects === 0) failures.push("no objects in the area (gazetteer built? coast tiles assigned?)");
  if (check.missing.length > 0) failures.push(`${check.missing.length} object(s) without a profile`);
  if (check.withoutProvenance.length > 0) failures.push(`${check.withoutProvenance.length} profile(s) with an attribute without provenance, rule or cited input`);
  if (!check.asOfCheck) failures.push("profileAsOf did not return the earlier version for the day before a later version");
  return failures;
}

/** Origins whose value must cite an input: a fact (text, review), a computation or a POI. */
const CITING_ORIGINS: ReadonlySet<AttributeProvenance["origin"]> = new Set(["text", "computed", "review"]);

/** Whether a provenance entry cites at least one fact, computation or POI. */
const citesInput = (p: AttributeProvenance) => p.factIds.length > 0 || p.computationIds.length > 0 || p.poiIds.length > 0;

/**
 * Attributes with a value whose provenance entry is missing, names no rule, or has origin `text`, `computed` or
 * `review` without citing a fact, computation or POI (bundle J review M-2: every built entry has a rule, so the rule
 * alone proves nothing). `rule`, `gazetteer` and `derived` values cite their rule or `derivedFrom` instead.
 */
export function attributesWithoutProvenance(attributes: Record<string, unknown>, provenance: Record<string, AttributeProvenance>): string[] {
  return Object.keys(attributes)
    .filter((key) => attributes[key] !== null && attributes[key] !== undefined)
    .filter((key) => {
      const p = provenance[key];
      return !p || !p.rule || (CITING_ORIGINS.has(p.origin) && !citesInput(p));
    })
    .sort();
}

/** `YYYY-MM-DD` one day earlier. */
function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The numbers of the check for the area `areaKey`: the valid, unmerged geo objects of the area's valid coast tiles
 * (the objects a consolidation run with `areaKey` takes), of level `place` with a confirmed place, or of level
 * `area`, `island`, `cape_strait`, `poi`. Throws for an unknown area.
 */
export async function profileStats(db: Db, areaKey: string): Promise<ProfileStats> {
  const { rows: area } = await db.execute<{ id: string }>(sql`
    select id from geo_objects a
    where a.type = 'area' and a.config_key = ${areaKey} and a.valid_from <= current_date and (a.valid_to is null or a.valid_to > current_date)
  `);
  if (area.length === 0) throw new Error(`unknown area ${areaKey} (no valid area object)`);

  const { rows } = await db.execute<{
    id: string;
    name: string | null;
    confirmed: boolean;
    version: number | null;
    attributes: Record<string, unknown> | null;
    provenance: Record<string, AttributeProvenance> | null;
    summary: "ok" | "empty" | null;
  }>(sql`
    select o.id, ${displayNameSql(sql`o.id`)} as name,
      exists (
        select 1 from places p
        where p.geo_object_id = o.id and p.status = 'confirmed' and p.valid_to is null and p.merged_into_id is null
      ) as confirmed,
      pr.version, pr.attributes, pr.provenance,
      (select case when bool_or(s.status = 'ok') then 'ok' when bool_or(s.status = 'empty') then 'empty' end
         from profile_summaries s where s.geo_object_id = o.id and s.profile_version = pr.version) as summary
    from (
      select distinct o.id
      from geo_objects a
      join tiles t on t.area_id = a.id and t.has_coast and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)
      join tile_geo_objects tgo on tgo.tile_id = t.id
      join geo_objects o on o.id = tgo.geo_object_id
        and o.merged_into_id is null and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
      where a.id = ${area[0]!.id}
    ) o
    left join lateral (
      select p.version, p.attributes, p.provenance from profiles p where p.geo_object_id = o.id order by p.version desc limit 1
    ) pr on true
  `);

  const objects: ProfileObjectStats[] = [];
  for (const r of rows) {
    const level = await levelFor(db, r.id);
    if (level === null) continue;
    if (level === "place" ? !r.confirmed : !OBJECT_LEVELS.includes(level)) continue;
    objects.push({
      geoObjectId: r.id,
      name: r.name,
      level,
      version: r.version === null ? null : Number(r.version),
      attributesWithoutProvenance: r.attributes ? attributesWithoutProvenance(r.attributes, r.provenance ?? {}) : [],
      summary: r.summary,
    });
  }
  const ids = JSON.stringify(objects.map((o) => o.geoObjectId));

  const { rows: tasks } = await db.execute<{ conflicts: number; uncertain: number }>(sql`
    select count(*) filter (where kind = 'conflict')::int as conflicts, count(*) filter (where kind = 'uncertain_change')::int as uncertain
    from review_tasks
    where kind in ('conflict', 'uncertain_change') and subject_type = 'profile_attribute' and status = 'open'
      and split_part(subject_id, ':', 1) in (select value from jsonb_array_elements_text(${ids}::jsonb))
  `);

  const { rows: versions } = await db.execute<{ geo_object_id: string; version: number; valid_from: string }>(sql`
    select geo_object_id, version, valid_from::text as valid_from from profiles
    where geo_object_id in (select value::uuid from jsonb_array_elements_text(${ids}::jsonb))
    order by geo_object_id, valid_from, version
  `);
  const byObject = new Map<string, Array<{ version: number; validFrom: string }>>();
  for (const v of versions) {
    const list = byObject.get(v.geo_object_id) ?? [];
    list.push({ version: Number(v.version), validFrom: v.valid_from });
    byObject.set(v.geo_object_id, list);
  }
  const asOfProbes: AsOfProbe[] = [];
  for (const [geoObjectId, list] of [...byObject].sort(([a], [b]) => a.localeCompare(b))) {
    const first = list[0]!.validFrom;
    const second = list.find((v) => v.validFrom > first);
    if (!second) continue;
    const expectedVersion = Math.max(...list.filter((v) => v.validFrom === first).map((v) => v.version));
    const date = dayBefore(second.validFrom);
    asOfProbes.push({ geoObjectId, date, expectedVersion, gotVersion: (await profileAsOf(db, geoObjectId, date))?.version ?? null });
  }

  return {
    objects,
    openConflicts: Number(tasks[0]?.conflicts ?? 0),
    openUncertain: Number(tasks[0]?.uncertain ?? 0),
    asOfProbes,
  };
}

/** M5 acceptance check of the profiles of area `areaKey`: `profileStats` assessed by `assessProfiles`. */
export async function checkProfiles(db: Db, areaKey: string): Promise<ProfilesCheck> {
  return assessProfiles(await profileStats(db, areaKey));
}
