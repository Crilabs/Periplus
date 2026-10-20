import { and, eq, isNull, sql } from "drizzle-orm";
import type { Transport } from "@/lib/adapters/http";
import { fetchSeas } from "@/lib/adapters/marine-regions";
import { buildBoundaryQuery, buildRelationQuery, overpassQuery, type OverpassElement } from "@/lib/adapters/overpass";
import type { Archive } from "@/lib/adapters/s3";
import { countryConfig, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects } from "@/lib/db/schema";
import { classifyOsm, osmNames } from "@/lib/domain/gazetteer/osm-classify";
import { upsertGeoObject } from "@/lib/domain/gazetteer/store";
import { createLogger } from "@/lib/logger";
import { elementGeometry } from "./osm";

export const COARSE_STAGE = "gazetteer.coarse";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("gazetteer.coarse"));

type Deps = { transport: Transport; archive?: Archive; runId?: string; now?: Date };

/**
 * Imports the IHO sea polygons of `subdivisions.mediterranean.marineRegionsMrgids` as geo objects of type `sea`
 * (origin `marine_regions`, `tags.mrgid`, name `en`). A sea that is stored already (valid, same mrgid) stays as it is.
 * A configured MRGID the WFS did not return is an error naming it, before anything is written. Returns the number of
 * seas created.
 */
export async function importSeas(db: Db, deps: Pick<Deps, "transport" | "runId">): Promise<number> {
  const { gazetteer, subdivisions } = getConfig();
  const mrgids = subdivisions.mediterranean.marineRegionsMrgids;
  const seas = await fetchSeas(deps.transport, mrgids, { db, runId: deps.runId, stage: COARSE_STAGE }, gazetteer.marineRegions);
  for (const mrgid of mrgids) {
    if (!seas.some((s) => s.mrgid === mrgid)) throw new Error(`marine regions: configured MRGID ${mrgid} is missing in the answer`);
  }
  return db.transaction(async (tx) => {
    let created = 0;
    for (const sea of seas) {
      const [existing] = await tx
        .select({ id: geoObjects.id })
        .from(geoObjects)
        .where(
          and(
            eq(geoObjects.type, "sea"),
            eq(geoObjects.origin, "marine_regions"),
            sql`${geoObjects.tags}->>'mrgid' = ${String(sea.mrgid)}`,
            isNull(geoObjects.validTo),
          ),
        );
      if (existing) continue;
      const r = await upsertGeoObject(tx, {
        type: "sea",
        origin: "marine_regions",
        tags: { mrgid: String(sea.mrgid) },
        geometry: sea.geometry,
        names: [{ name: sea.name, language: "en", origin: "manual", isPreferred: true }],
      });
      if ("skipped" in r) throw new Error(`marine regions ${sea.mrgid}: unusable geometry (${r.skipped})`);
      created++;
    }
    return created;
  });
}

/** OSM relation ids and Wikidata ids of the configuration that make a relation belong to `country` regardless of its tags. */
function configured(country: string) {
  const { subdivisions } = getConfig();
  const extras = subdivisions.extra.filter((e) => e.country === country).map((e) => e.osmRelationId);
  const members = new Set(subdivisions.split.flatMap((s) => s.groups.flatMap((g) => g.memberWikidataIds)));
  return { extras, members };
}

/** The OSM levels queried for a country: its first and second level; none for a whole country. */
function levelsOf(country: string): number[] {
  const { subdivisions } = getConfig();
  const c = countryConfig(country);
  if (c.firstLevel === "whole" || subdivisions.wholeCountry.includes(country)) return [];
  return [...new Set([c.firstLevel, ...(c.secondLevel ? [c.secondLevel] : [])])];
}

/** The unit's point on surface lies within the country polygon of `countryId`. */
async function insideCountry(db: Db, countryId: string, geometry: NonNullable<ReturnType<typeof elementGeometry>>): Promise<boolean> {
  if (!("lines" in geometry)) return false;
  const lines = sql.join(geometry.lines.map((l) => geomFromGeoJson(l)), sql`, `);
  const { rows } = await db.execute<{ inside: boolean | null }>(sql`
    SELECT ST_Covers(c.geom, ST_PointOnSurface(ST_BuildArea(ST_Collect(ARRAY[${lines}])))) AS inside
    FROM geo_objects c WHERE c.id = ${countryId}::uuid`);
  return rows[0]?.inside === true;
}

/**
 * Stage `gazetteer.coarse` for one country (spec 14): the OSM boundary relations of its first and second level plus
 * the country relation itself, and the `extra` relations of the country. Overpass area queries leak across borders
 * (Croatia's answer holds Vojvodina), so the country is attached by configuration: a relation is kept when it is the
 * country's own `admin_level=2` relation, is configured (`keyOverrides`, `extra`, split members), carries an
 * `ISO3166-2` tag of this country, or has no `ISO3166-2` tag and lies within the country polygon. Stored as geo objects
 * `country` / `admin_region` with `admin_level` and `tags.country`. Archives the raw answers when an archive is given.
 */
export async function importCoarse(
  db: Db,
  country: string,
  deps: Deps,
): Promise<{ countries: number; regions: number }> {
  const { gazetteer, subdivisions } = getConfig();
  countryConfig(country);
  const levels = levelsOf(country);
  const { extras, members } = configured(country);
  const ctx = { db, runId: deps.runId, stage: COARSE_STAGE };
  const date = (deps.now ?? new Date()).toISOString().slice(0, 10);

  const answers: OverpassElement[][] = [];
  const queries = [buildBoundaryQuery(country, levels, gazetteer.overpass.timeoutSeconds)];
  if (extras.length > 0) queries.push(buildRelationQuery(extras, gazetteer.overpass.timeoutSeconds));
  for (const [i, ql] of queries.entries()) {
    const { raw, elements } = await overpassQuery(deps.transport, ql, ctx, gazetteer.overpass);
    await deps.archive?.put(`datasets/overpass/boundaries/${country}/${date}${i === 0 ? "" : `-extra`}.json`, raw, "application/json");
    answers.push(elements);
  }
  const elements = answers.flat();
  const seen = new Set<number>();
  const relations = elements.filter((e) => e.type === "relation" && !seen.has(e.id) && !!seen.add(e.id));

  const isOwnCountry = (e: OverpassElement) => e.tags?.admin_level === "2" && e.tags["ISO3166-1"] === country;
  const isConfigured = (e: OverpassElement) =>
    extras.includes(e.id) || String(e.id) in subdivisions.keyOverrides || (!!e.tags?.wikidata && members.has(e.tags.wikidata));

  return db.transaction(async (tx) => {
    const store = async (e: OverpassElement) => {
      const tags = e.tags ?? {};
      const cls = classifyOsm(tags, getConfig().categories, "relation");
      const geometry = elementGeometry(e);
      if (!cls || !cls.adminLevel || !geometry) return null;
      const osmId = `relation/${e.id}`;
      const wikidata = tags.wikidata;
      const [taken] = wikidata
        ? await tx
            .select({ osmId: geoObjects.osmId })
            .from(geoObjects)
            .where(and(eq(geoObjects.wikidataId, wikidata), isNull(geoObjects.validTo)))
        : [];
      const r = await upsertGeoObject(tx, {
        type: cls.type,
        adminLevel: cls.adminLevel,
        origin: "osm",
        osmId,
        wikidataId: wikidata && (!taken || taken.osmId === osmId) ? wikidata : undefined,
        tags: {
          boundary: "administrative",
          admin_level: String(cls.adminLevel),
          country,
          ...(tags["ISO3166-1"] ? { "ISO3166-1": tags["ISO3166-1"] } : {}),
          ...(tags["ISO3166-2"] ? { "ISO3166-2": tags["ISO3166-2"] } : {}),
          ...(wikidata ? { wikidata } : {}),
        },
        geometry,
        names: osmNames(tags),
      });
      if ("skipped" in r) {
        getLog().warn({ osmId, reason: r.skipped }, "skipped boundary with unusable geometry");
        return null;
      }
      return { id: r.id, geometry };
    };

    const result = { countries: 0, regions: 0 };
    let countryId: string | undefined;
    for (const e of relations.filter((x) => isOwnCountry(x) || (x.tags?.admin_level === "2" && isConfigured(x)))) {
      const stored = await store(e);
      if (!stored) continue;
      countryId ??= stored.id;
      result.countries++;
    }
    if (!countryId) throw new Error(`gazetteer.coarse ${country}: no country relation (admin_level 2) in the Overpass answer`);

    for (const e of relations) {
      if (e.tags?.admin_level === "2") continue;
      const iso = e.tags?.["ISO3166-2"];
      let keep = isConfigured(e) || (iso !== undefined && iso.startsWith(`${country}-`));
      if (!keep && iso === undefined) {
        const geometry = elementGeometry(e);
        keep = !!geometry && (await insideCountry(tx, countryId, geometry));
      }
      if (!keep) {
        getLog().info({ country, relation: e.id, iso }, "boundary outside the country skipped");
        continue;
      }
      if (await store(e)) result.regions++;
    }
    return result;
  });
}
