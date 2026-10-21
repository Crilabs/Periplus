import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { displayNameSql } from "@/lib/domain/gazetteer/names";

/*
 * Read-only view of an imported area (spec 14, „Admin-UI“): what the Revier-Bot delivered (names, members, boundary,
 * relations, evidence, notes) plus the subdivisions whose scope the area touches. Nothing here edits; corrections
 * happen in the bot.
 */

/**
 * Subdivisions (rows with `s.key`, `s.id`) whose scope tiles (valid coast tiles meeting the subdivision's polygon
 * beyond a shared border) the area `areaId` (an SQL expression) is linked to.
 */
export const areaSubdivisionsSql = (areaId: SQL): SQL => sql`
  select s.id, s.key, s.geo_object_id
  from subdivisions s
  where s.valid_to is null and exists (
    select 1 from tile_geo_objects tg
    join tiles t on t.id = tg.tile_id and t.has_coast and t.valid_to is null
    where tg.geo_object_id = ${areaId}
      and ST_Intersects(t.bbox, s.geom) and not ST_Touches(t.bbox, s.geom)
  )`;

export type AreaDetail = {
  id: string;
  publicId: string | null;
  key: string;
  names: Array<{ name: string; language: string; isPreferred: boolean }>;
  members: Array<{ id: string; name: string; type: string; role: string }>;
  unresolvedMembers: Array<{ name: string; type: string; role: string }>;
  boundary: string;
  related: Array<{ key: string; relation: string; id: string | null; name: string | null }>;
  evidence: Array<{ url: string; publisher: string; language: string; quote: string }>;
  notes: string;
  polygonOrigin: string;
  subdivisions: Array<{ key: string; name: string }>;
  /** The country of the bot file the area was imported from. */
  importedFrom: string;
};

type Tags = {
  boundary?: unknown;
  related?: unknown;
  notes?: unknown;
  unresolvedMembers?: unknown;
  polygonOrigin?: unknown;
  importCountry?: unknown;
};

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);

/**
 * The detail of a valid, unmerged area (`ar_`) for the map panel: names (valid ones), members (resolved with type,
 * role and name; unresolved ones from the import's tags), boundary text, relations (with the related area's id and
 * name when it is valid), evidence (oldest first), notes and the subdivisions it touches. `areaId` must be a UUID. Null for an unknown, ended
 * or merged area.
 */
export async function areaDetail(db: Db, areaId: string): Promise<AreaDetail | null> {
  const { rows } = await db.execute<{ id: string; public_id: string | null; config_key: string | null; tags: Tags | null }>(sql`
    select id, public_id, config_key, tags from geo_objects
    where id = ${areaId}::uuid and type = 'area' and merged_into_id is null
      and valid_from <= current_date and (valid_to is null or valid_to > current_date)`);
  const area = rows[0];
  if (!area) return null;
  const tags = area.tags ?? {};

  const { rows: names } = await db.execute<{ name: string; language: string; is_preferred: boolean }>(sql`
    select name, language, is_preferred from geo_names
    where geo_object_id = ${area.id} and (valid_to is null or valid_to > current_date)
    order by language, is_preferred desc, name`);
  const { rows: members } = await db.execute<{ id: string; name: string; type: string; role: string }>(sql`
    select m.geo_object_id as id, coalesce(${displayNameSql(sql`m.geo_object_id`)}, m.name) as name, o.type::text as type, m.role::text as role
    from area_members m join geo_objects o on o.id = m.geo_object_id
    where m.area_id = ${area.id}
    order by m.role, name`);
  const { rows: evidence } = await db.execute<{ url: string; publisher: string; language: string; quote: string }>(sql`
    select url, publisher, language, quote from area_evidence where area_id = ${area.id} order by created_at, id`);
  const { rows: subs } = await db.execute<{ key: string; name: string | null }>(sql`
    select x.key, ${displayNameSql(sql`x.geo_object_id`)} as name from (${areaSubdivisionsSql(sql`${area.id}::uuid`)}) x order by x.key`);

  const relatedKeys = list(tags.related).map((r) => text(r.key));
  const { rows: relatedAreas } = relatedKeys.length
    ? await db.execute<{ id: string; config_key: string; name: string | null }>(sql`
        select o.id, o.config_key, ${displayNameSql(sql`o.id`)} as name from geo_objects o
        where o.type = 'area' and o.merged_into_id is null and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
          and o.config_key in (select jsonb_array_elements_text(${JSON.stringify(relatedKeys)}::jsonb))`)
    : { rows: [] };
  const byKey = new Map(relatedAreas.map((r) => [r.config_key, r]));

  return {
    id: area.id,
    publicId: area.public_id,
    key: area.config_key ?? "",
    names: names.map((n) => ({ name: n.name, language: n.language, isPreferred: n.is_preferred })),
    members: members.map((m) => ({ id: m.id, name: m.name, type: m.type, role: m.role })),
    unresolvedMembers: list(tags.unresolvedMembers).map((u) => ({ name: text(u.name), type: text(u.type), role: text(u.role) })),
    boundary: text(tags.boundary),
    related: list(tags.related).map((r) => {
      const found = byKey.get(text(r.key));
      return { key: text(r.key), relation: text(r.relation), id: found?.id ?? null, name: found?.name ?? null };
    }),
    evidence: evidence.map((e) => ({ url: e.url, publisher: e.publisher, language: e.language, quote: e.quote })),
    notes: text(tags.notes),
    polygonOrigin: text(tags.polygonOrigin),
    subdivisions: subs.map((s) => ({ key: s.key, name: s.name ?? s.key })),
    importedFrom: text(tags.importCountry),
  };
}

export type SubdivisionOption = { key: string; name: string; bbox: [number, number, number, number] };

/** The valid subdivisions (key, display name, bounding box; sorted by name) for the Landesteil filter of the map. */
export async function subdivisionOptions(db: Db): Promise<SubdivisionOption[]> {
  const { rows } = await db.execute<{ key: string; name: string | null; w: number; s: number; e: number; n: number }>(sql`
    select s.key, ${displayNameSql(sql`s.geo_object_id`)} as name,
      ST_XMin(s.geom) as w, ST_YMin(s.geom) as s, ST_XMax(s.geom) as e, ST_YMax(s.geom) as n
    from subdivisions s where s.valid_to is null order by s.key`);
  const collator = new Intl.Collator("de");
  return rows
    .map((r): SubdivisionOption => ({ key: r.key, name: r.name ?? r.key, bbox: [Number(r.w), Number(r.s), Number(r.e), Number(r.n)] }))
    .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.key, b.key));
}
