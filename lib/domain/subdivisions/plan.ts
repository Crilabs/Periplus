import type { SubdivisionsConfig } from "@/lib/config";
import type { SubdivisionStatus } from "@/lib/db/schema";

/**
 * A country or admin region of the coarse gazetteer, as far as planning needs it. The geometry stays in the
 * database (`geo_objects.geom`); a plan refers to units by `geoObjectId`.
 */
export type AdminUnit = {
  geoObjectId: string;
  /** ISO 3166-1 alpha-2, attached by configuration at import, not by area membership. */
  country: string;
  /** OSM admin_level (2 = country). */
  adminLevel: number;
  /** `ISO3166-2` tag. */
  iso: string | null;
  osmRelationId: number;
  wikidataId: string | null;
  /** The unit lies within 2 km of a configured Mediterranean sea polygon. */
  touchesMediterranean: boolean;
};

export type PlannedSubdivision = {
  key: string;
  country: string;
  /** The country or admin region the subdivision is; null for a split group or merge, whose geo object is made from its members. */
  geoObjectId: string | null;
  /** Geo objects whose union is the subdivision's polygon. */
  memberGeoObjectIds: string[];
  /** Geo objects cut out of the polygon (`extra` units of the same country). */
  cutGeoObjectIds: string[];
  /** admin_level of the made geo object (the country's first level), for a split group or merge. */
  adminLevel: number | null;
  status: SubdivisionStatus;
  statusReason: string | null;
  /** Names from configuration (group, merge, extra); empty when the geo object carries the names. */
  names: Record<string, string>;
};

const COUNTRY_LEVEL = 2;

/** Key of a unit: `keyOverrides[relation id]`, else ISO 3166-2, else the country itself, else `<country>-<Qid>`. */
function unitKey(u: AdminUnit, cfg: SubdivisionsConfig): string {
  const override = cfg.keyOverrides[String(u.osmRelationId)];
  if (override) return override;
  if (u.iso) return u.iso;
  if (u.adminLevel === COUNTRY_LEVEL) return u.country;
  return `${u.country}-${u.wikidataId ?? `R${u.osmRelationId}`}`;
}

function isWhole(country: string, cfg: SubdivisionsConfig): boolean {
  return cfg.wholeCountry.includes(country) || cfg.countries[country]?.firstLevel === "whole";
}

/**
 * The Landesteile of the coarse gazetteer (spec 14), sorted by key. Rules in order: a country with status
 * `excluded` is one excluded row; a whole country (`wholeCountry`, `firstLevel: "whole"`) is its country unit; else
 * the first-level units touching the Mediterranean minus `notMediterranean`. Then `split` replaces a parent by its
 * groups (union of the second-level units named by Wikidata id), `merge` replaces its members by one row, `extra`
 * adds a unit and cuts it out of the rows of its `cutFrom` country. `overrides` set status and reason. A duplicate
 * key keeps the first row. Nothing throws on missing ISO tags or unmatched configuration.
 */
export function planSubdivisions(units: AdminUnit[], cfg: SubdivisionsConfig): PlannedSubdivision[] {
  const rows: PlannedSubdivision[] = [];
  const row = (u: AdminUnit, key: string, status: SubdivisionStatus, statusReason: string | null): PlannedSubdivision => ({
    key,
    country: u.country,
    geoObjectId: u.geoObjectId,
    memberGeoObjectIds: [u.geoObjectId],
    cutGeoObjectIds: [],
    adminLevel: null,
    status,
    statusReason,
    names: {},
  });

  for (const [country, c] of Object.entries(cfg.countries)) {
    const own = units.filter((u) => u.country === country);
    if (c.status === "excluded") {
      for (const u of own.filter((x) => x.adminLevel === COUNTRY_LEVEL)) {
        rows.push(row(u, unitKey(u, cfg), "excluded", c.statusReason ?? null));
      }
    } else if (isWhole(country, cfg)) {
      for (const u of own.filter((x) => x.adminLevel === COUNTRY_LEVEL)) rows.push(row(u, unitKey(u, cfg), "active", null));
    } else if (c.firstLevel !== "whole") {
      const firstLevel = c.firstLevel;
      for (const u of own.filter((x) => x.adminLevel === firstLevel && x.touchesMediterranean)) {
        const key = unitKey(u, cfg);
        if (!cfg.notMediterranean.includes(key)) rows.push(row(u, key, "active", null));
      }
    }
  }

  for (const split of cfg.split) {
    const at = rows.findIndex((r) => r.key === split.parentKey);
    if (at < 0) continue;
    const parent = rows[at]!;
    const pool = units.filter((u) => u.country === parent.country && u.wikidataId);
    const groups = split.groups.map((g): PlannedSubdivision => ({
      key: g.key,
      country: parent.country,
      geoObjectId: null,
      memberGeoObjectIds: pool.filter((u) => g.memberWikidataIds.includes(u.wikidataId!)).map((u) => u.geoObjectId),
      cutGeoObjectIds: [],
      adminLevel: unitFirstLevel(parent.country, cfg),
      status: parent.status,
      statusReason: parent.statusReason,
      names: g.names,
    }));
    rows.splice(at, 1, ...groups.filter((g) => g.memberGeoObjectIds.length > 0));
  }

  for (const merge of cfg.merge) {
    const members = merge.memberKeys.map((k) => rows.find((r) => r.key === k)).filter((r): r is PlannedSubdivision => !!r);
    if (members.length === 0) continue;
    const first = members[0]!;
    const at = rows.indexOf(first);
    for (const m of members) rows.splice(rows.indexOf(m), 1);
    rows.splice(Math.min(at, rows.length), 0, {
      key: merge.key,
      country: first.country,
      geoObjectId: null,
      memberGeoObjectIds: [...new Set(members.flatMap((m) => m.memberGeoObjectIds))],
      cutGeoObjectIds: [],
      adminLevel: unitFirstLevel(first.country, cfg),
      status: first.status,
      statusReason: first.statusReason,
      names: merge.names,
    });
  }

  for (const extra of cfg.extra) {
    const u = units.find((x) => x.osmRelationId === extra.osmRelationId);
    if (!u) continue;
    for (const r of rows) {
      if (r.country === extra.cutFrom && r.status === "active") r.cutGeoObjectIds = [...r.cutGeoObjectIds, u.geoObjectId];
    }
    rows.push({ ...row(u, extra.key, "active", null), country: extra.country, names: extra.names });
  }

  for (const r of rows) {
    const o = cfg.overrides[r.key];
    if (o?.status) r.status = o.status;
    if (o?.statusReason) r.statusReason = o.statusReason;
    else if (o?.status === "active") r.statusReason = null;
  }

  const seen = new Set<string>();
  return rows
    .filter((r) => !seen.has(r.key) && !!seen.add(r.key))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function unitFirstLevel(country: string, cfg: SubdivisionsConfig): number | null {
  const level = cfg.countries[country]?.firstLevel;
  return typeof level === "number" ? level : null;
}

/**
 * Configuration that matches nothing in the imported units or the plan: split parents and groups, merge members,
 * `notMediterranean`, `extra` relations, `overrides` keys. Reported by the
 * build, never thrown (a config key may refer to a unit of a country that is not imported yet).
 */
export function planWarnings(units: AdminUnit[], cfg: SubdivisionsConfig, plan: PlannedSubdivision[]): string[] {
  const out: string[] = [];
  const unitKeys = new Set(units.map((u) => unitKey(u, cfg)));
  const planKeys = new Set(plan.map((p) => p.key));
  for (const s of cfg.split) {
    if (!unitKeys.has(s.parentKey)) out.push(`split parent ${s.parentKey} matches no unit`);
    for (const g of s.groups) {
      if (!plan.some((p) => p.key === g.key)) out.push(`split group ${g.key} of ${s.parentKey} has no members`);
    }
  }
  for (const m of cfg.merge) {
    for (const k of m.memberKeys) if (!unitKeys.has(k) && !planKeys.has(k)) out.push(`merge ${m.key}: member ${k} matches no unit`);
  }
  for (const k of cfg.notMediterranean) if (!unitKeys.has(k)) out.push(`notMediterranean ${k} matches no unit`);
  for (const e of cfg.extra) {
    if (!units.some((u) => u.osmRelationId === e.osmRelationId)) out.push(`extra ${e.key}: relation ${e.osmRelationId} not imported`);
  }
  for (const k of Object.keys(cfg.overrides)) {
    if (!planKeys.has(k) && !unitKeys.has(k)) out.push(`overrides ${k} matches no unit`);
  }
  return out;
}
