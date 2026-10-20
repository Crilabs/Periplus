import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { areaEvidence, areaMembers, geoNames, geoObjects } from "@/lib/db/schema";
import { addNames, isGreek, transliterateElot743 } from "@/lib/domain/gazetteer/names";
import { publicIdFor } from "@/lib/domain/gazetteer/store";
import { assignTiles } from "@/lib/domain/gazetteer/hierarchy";
import { jsonTexts, jsonUuids } from "@/lib/domain/mentions/scope";
import type { ImportedArea } from "./file";
import type { ResolvedMember } from "./resolve";

/*
 * Rows of an imported area (spec 14, „Änderung 21.10.2026“): the geo object `area`, its `import` names, its evidence
 * (append-only) and its members (working state). Every writer only writes what differs, so a second import of the same
 * file changes no row.
 */

export type StoredArea = { id: string; configKey: string; publicId: string | null; tags: Record<string, unknown> };

/**
 * The area of a bot key: the valid one by `config_key = key`, else by a legacy key whose alias (`aliases[legacy] =
 * key`) is this key (`viaAlias`). Without a valid one, the most recently ended area of these keys imported for
 * `country` (`tags.importCountry`), marked `ended`: a key the bot dropped and lists again gets its area, `ar_` id
 * included, back (`reviveArea`).
 */
export async function findArea(
  db: Db,
  key: string,
  aliases: Record<string, string>,
  country: string,
): Promise<(StoredArea & { viaAlias: boolean; ended: boolean }) | null> {
  const legacy = Object.entries(aliases).filter(([, to]) => to === key).map(([from]) => from);
  const { rows } = await db.execute<{
    id: string;
    config_key: string;
    public_id: string | null;
    tags: Record<string, unknown>;
    ended: boolean;
  }>(sql`
    select id, config_key, public_id, tags, valid_to is not null as ended from geo_objects
    where type = 'area' and merged_into_id is null
      and config_key in ${jsonTexts([key, ...legacy])}
      and (valid_to is null or tags->>'importCountry' = ${country})
    order by (valid_to is null) desc, (config_key = ${key}) desc, valid_to desc, id desc
    limit 1
    for update`);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    configKey: r.config_key,
    publicId: r.public_id,
    tags: r.tags ?? {},
    viaAlias: r.config_key !== key,
    ended: r.ended,
  };
}

/** Makes an ended area valid again (`valid_to = null`); `linkTiles` rebuilds its tile links after the update. */
export async function reviveArea(db: Db, areaId: string): Promise<void> {
  await db.execute(sql`update geo_objects set valid_to = null, updated_at = now() where id = ${areaId}`);
}

/** Rewrites the links of the tiles the area's current polygon meets. */
export async function linkTiles(db: Db, areaId: string): Promise<void> {
  const { rows } = await db.execute<{ g: string }>(sql`select geom::text as g from geo_objects where id = ${areaId}`);
  await assignTiles(db, await tilesMeeting(db, [rows[0]!.g]));
}

/** Valid tiles whose box meets any of the geometries (hex EWKB or null). */
async function tilesMeeting(db: Db, geoms: Array<string | null>): Promise<string[]> {
  const list = geoms.filter((g): g is string => g !== null);
  if (list.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct t.id from tiles t
    join (select value::geometry as g from jsonb_array_elements_text(${JSON.stringify(list)}::jsonb)) x
      on t.bbox && x.g and ST_Intersects(t.bbox, x.g)
    where t.valid_to is null
    order by t.id`);
  return rows.map((r) => r.id);
}

/** Creates the area (`origin import`, `ar_` public id) and links it to the tiles it meets. Returns its id. */
export async function createArea(db: Db, key: string, geom: string, tags: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(geoObjects)
    .values({ type: "area", origin: "import", configKey: key, publicId: publicIdFor("area"), tags, geom: sql`${geom}::geometry` })
    .returning({ id: geoObjects.id });
  await assignTiles(db, await tilesMeeting(db, [geom]));
  return row!.id;
}

/**
 * Updates an existing area where it differs: `config_key` (an area taken over by alias), `tags` (jsonb equality), the
 * public id when it has none, and `geom` when not `ST_Equals` (then the tiles meeting the old or the new polygon get
 * their links rewritten). Returns whether anything was written.
 */
export async function updateArea(
  db: Db,
  area: StoredArea,
  key: string,
  geom: string | null,
  tags: Record<string, unknown>,
): Promise<boolean> {
  let changed = false;
  const res = await db.execute(sql`
    update geo_objects set config_key = ${key}, tags = ${JSON.stringify(tags)}::jsonb,
      public_id = coalesce(public_id, ${publicIdFor("area")}), updated_at = now()
    where id = ${area.id}
      and (config_key is distinct from ${key} or tags is distinct from ${JSON.stringify(tags)}::jsonb or public_id is null)`);
  if ((res.rowCount ?? 0) > 0) changed = true;
  if (geom !== null) {
    const { rows } = await db.execute<{ old: string }>(sql`
      select geom::text as old from geo_objects where id = ${area.id} and not ST_Equals(geom, ${geom}::geometry)`);
    const old = rows[0]?.old;
    if (old !== undefined) {
      await db.execute(sql`update geo_objects set geom = ${geom}::geometry, updated_at = now() where id = ${area.id}`);
      await assignTiles(db, await tilesMeeting(db, [old, geom]));
      changed = true;
    }
  }
  return changed;
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ");

/**
 * Brings the area's `import` names to the file: adds new names (`addNames`, origin `import`), ends (`valid_to = today`)
 * import names the file no longer lists and transliterations whose Greek source name is no longer valid, and makes the
 * file's preferred name of a language the only preferred valid name of that language (`addNames` alone keeps an
 * existing preferred name). Returns the number of rows written.
 */
export async function syncAreaNames(db: Db, areaId: string, names: ImportedArea["names"], today: string): Promise<number> {
  let written = await addNames(
    db,
    areaId,
    names.map((n) => ({ name: n.name, language: n.lang, origin: "import" as const, isPreferred: n.preferred })),
  );
  const listed = new Set(names.map((n) => JSON.stringify([cleanName(n.name), n.lang])));
  const valid = await db
    .select({ id: geoNames.id, name: geoNames.name, language: geoNames.language, origin: geoNames.origin, script: geoNames.script, isPreferred: geoNames.isPreferred })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, areaId), isNull(geoNames.validTo)));
  const gone = valid.filter((n) => n.origin === "import" && !listed.has(JSON.stringify([n.name, n.language])));
  const goneIds = new Set(gone.map((n) => n.id));
  const sources = new Set(
    valid
      .filter((n) => !goneIds.has(n.id) && n.origin !== "transliteration" && isGreek(n.name))
      .map((n) => transliterateElot743(n.name)),
  );
  const orphans = valid.filter((n) => n.origin === "transliteration" && !sources.has(n.name));
  const end = [...gone, ...orphans].map((n) => n.id);
  if (end.length > 0) {
    await db.update(geoNames).set({ validTo: today }).where(inArray(geoNames.id, end));
    written += end.length;
  }

  const preferred = new Map(names.filter((n) => n.preferred).map((n) => [n.lang, cleanName(n.name)]));
  const ended = new Set(end);
  for (const n of valid) {
    if (ended.has(n.id) || !preferred.has(n.language)) continue;
    const want = n.origin === "import" && n.name === preferred.get(n.language);
    if (n.isPreferred !== want) {
      await db.update(geoNames).set({ isPreferred: want }).where(eq(geoNames.id, n.id));
      written++;
    }
  }
  return written;
}

/** Appends the file's evidence (`on conflict do nothing` on area, url, quote). Returns the number of new rows. */
export async function addAreaEvidence(
  db: Db,
  areaId: string,
  evidence: ImportedArea["evidence"],
  fileGeneratedAt: string,
): Promise<number> {
  if (evidence.length === 0) return 0;
  const rows = await db
    .insert(areaEvidence)
    .values(
      evidence.map((e) => ({ areaId, url: e.url, publisher: e.publisher, language: e.lang, quote: e.quote, fileGeneratedAt })),
    )
    .onConflictDoNothing()
    .returning({ id: areaEvidence.id });
  return rows.length;
}

/**
 * Replaces the area's members with the resolved ones (one row per object and role, the first name) when the set of
 * (object, role, name) differs. Returns whether it was rewritten.
 */
export async function syncAreaMembers(db: Db, areaId: string, resolved: ResolvedMember[]): Promise<boolean> {
  const wanted = new Map<string, ResolvedMember>();
  for (const m of resolved) {
    const k = `${m.geoObjectId}|${m.role}`;
    if (!wanted.has(k)) wanted.set(k, m);
  }
  const current = await db
    .select({ geoObjectId: areaMembers.geoObjectId, role: areaMembers.role, name: areaMembers.name })
    .from(areaMembers)
    .where(eq(areaMembers.areaId, areaId));
  const sig = (m: { geoObjectId: string; role: string; name: string }) => `${m.geoObjectId}|${m.role}|${m.name}`;
  const a = new Set(current.map(sig));
  const b = new Set([...wanted.values()].map(sig));
  if (a.size === b.size && [...a].every((s) => b.has(s))) return false;
  await db.delete(areaMembers).where(eq(areaMembers.areaId, areaId));
  if (wanted.size > 0) {
    await db.insert(areaMembers).values([...wanted.values()].map((m) => ({ areaId, geoObjectId: m.geoObjectId, role: m.role, name: m.name })));
  }
  return true;
}

/**
 * Ends (`valid_to = today`) the valid areas imported for `country` (`tags.importCountry`) whose key is not in `keys`
 * and removes their tile links. Returns their keys.
 */
export async function endMissingAreas(db: Db, country: string, keys: string[], today: string): Promise<string[]> {
  const { rows } = await db.execute<{ id: string; config_key: string }>(sql`
    update geo_objects set valid_to = ${today}, updated_at = now()
    where type = 'area' and valid_to is null and tags->>'importCountry' = ${country}
      and (config_key is null or config_key not in ${jsonTexts(keys)})
    returning id, config_key`);
  if (rows.length === 0) return [];
  await db.execute(sql`delete from tile_geo_objects where geo_object_id in ${jsonUuids(rows.map((r) => r.id))}`);
  return rows.map((r) => r.config_key).sort();
}
