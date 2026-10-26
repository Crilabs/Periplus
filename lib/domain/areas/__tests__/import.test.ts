import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geoObjects } from "@/lib/db/schema";
import { importAreaFile } from "@/lib/domain/areas/import";
import { addNames } from "@/lib/domain/gazetteer/names";
import { newPublicId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { insertScene, sceneArea, sceneConfig, sceneFile, SCENE_COUNTRY } from "@/test/fixtures/areas/scene";

const cfg = sceneConfig();

async function today(db: Db): Promise<string> {
  const { rows } = await db.execute<{ d: string }>(sql`select current_date::text as d`);
  return rows[0]!.d;
}

type AreaRow = {
  id: string;
  public_id: string | null;
  config_key: string;
  origin: string;
  valid_to: string | null;
  tags: Record<string, unknown>;
};

async function area(db: Db, key: string): Promise<AreaRow | undefined> {
  const { rows } = await db.execute<AreaRow>(sql`
    select id, public_id, config_key, origin::text, valid_to::text, tags from geo_objects
    where type = 'area' and config_key = ${key} order by created_at desc limit 1`);
  return rows[0];
}

/** Counts that must not move on an idempotent re-import. */
async function counts(db: Db, ids: string[]) {
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const { rows } = await db.execute<{ names: number; evidence: number; members: number; links: number }>(sql`
    select (select count(*)::int from geo_names where geo_object_id in (${list})) as names,
           (select count(*)::int from area_evidence where area_id in (${list})) as evidence,
           (select count(*)::int from area_members where area_id in (${list})) as members,
           (select count(*)::int from tile_geo_objects where geo_object_id in (${list})) as links`);
  return rows[0]!;
}

async function members(db: Db, areaId: string) {
  const { rows } = await db.execute<{ geo_object_id: string; role: string; name: string }>(sql`
    select geo_object_id, role::text, name from area_members where area_id = ${areaId} order by name`);
  return rows;
}

async function names(db: Db, areaId: string) {
  const { rows } = await db.execute<{ name: string; language: string; origin: string; is_preferred: boolean; valid: boolean }>(sql`
    select name, language, origin::text, is_preferred, (valid_to is null) as valid from geo_names
    where geo_object_id = ${areaId} order by language, name, valid_to nulls first`);
  return rows;
}

async function links(db: Db, areaId: string): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from tile_geo_objects where geo_object_id = ${areaId}`);
  return rows[0]!.n;
}

describe("importAreaFile", () => {
  it("creates the areas with names, evidence, members, tags and tile links; a second import changes nothing", () =>
    withRollback(async (db) => {
      const scene = await insertScene(db);
      const day = await today(db);
      const report = await importAreaFile(db, sceneFile(), cfg, day);
      expect(report.created.sort()).toEqual(["teranos-gulf", "velani-coast", "vrachos"]);
      expect(report.updated).toEqual([]);
      expect(report.waiting).toEqual([]);
      expect(report.unknownSubdivisions).toEqual([{ key: "vrachos", subdivision: "ZT-UNKNOWN" }]);

      const velani = (await area(db, "velani-coast"))!;
      expect(velani.public_id).toMatch(/^ar_/);
      expect(velani.origin).toBe("import");
      expect(velani.tags).toEqual({
        boundary: "Boundary of velani-coast",
        related: [],
        notes: "Notes on velani-coast",
        unresolvedMembers: [],
        polygonOrigin: "computed",
        importCountry: SCENE_COUNTRY,
      });
      expect(await members(db, velani.id)).toEqual([
        { geo_object_id: scene.objects.dorkasi, role: "member", name: "Dorkasi" },
        { geo_object_id: scene.objects.myrtidi, role: "member", name: "Myrtidi" },
        { geo_object_id: scene.objects.sarandi, role: "boundary", name: "Sarandi" },
        { geo_object_id: scene.objects.velani, role: "member", name: "Velani" },
      ]);
      expect((await names(db, velani.id)).filter((n) => n.origin === "import")).toEqual([
        { name: "Ακτή Βελάνης", language: "el", origin: "import", is_preferred: true, valid: true },
        { name: "Velani Coast", language: "en", origin: "import", is_preferred: true, valid: true },
      ]);
      const { rows: ev } = await db.execute<{ url: string; publisher: string; language: string; file_generated_at: string }>(sql`
        select url, publisher, language, file_generated_at::text from area_evidence where area_id = ${velani.id}`);
      expect(ev).toEqual([
        { url: "https://example.invalid/velani-coast/0", publisher: "Example Pilot", language: "en", file_generated_at: "2026-10-20" },
      ]);
      expect(await links(db, velani.id)).toBeGreaterThan(0);

      const teranos = (await area(db, "teranos-gulf"))!;
      expect(teranos.tags).toMatchObject({
        polygonOrigin: "gulf",
        unresolvedMembers: [{ name: "Agios Stefanos", type: "harbour", role: "member" }],
      });
      expect((await members(db, teranos.id)).map((m) => m.name)).toEqual(["Lefkori", "Petrili", "Teranos Gulf"]);

      const ids = [velani.id, teranos.id, (await area(db, "vrachos"))!.id];
      const before = await counts(db, ids);
      const again = await importAreaFile(db, sceneFile(), cfg, day);
      expect(again.unchanged.sort()).toEqual(["teranos-gulf", "velani-coast", "vrachos"]);
      expect(again.created).toEqual([]);
      expect(again.updated).toEqual([]);
      expect(again.ended).toEqual([]);
      expect(await counts(db, ids)).toEqual(before);
    }));

  it("writes only the bot's changes on re-import and ends a dropped area without tile links (Review Focus 3)", () =>
    withRollback(async (db) => {
      const scene = await insertScene(db);
      const day = await today(db);
      await importAreaFile(db, sceneFile(), cfg, day);
      const velani = (await area(db, "velani-coast"))!;
      const teranos = (await area(db, "teranos-gulf"))!;
      const vrachos = (await area(db, "vrachos"))!;
      const before = await counts(db, [velani.id, teranos.id]);
      expect(await links(db, vrachos.id)).toBeGreaterThan(0);

      const file = sceneFile();
      const v = file.areas.find((a) => a.key === "velani-coast")!;
      v.names.push({ lang: "de", name: "Velani-Küste", preferred: true });
      v.members = v.members.filter((m) => m.name !== "Myrtidi");
      const t = file.areas.find((a) => a.key === "teranos-gulf")!;
      t.evidence.push({ url: "https://example.invalid/teranos-gulf/new", publisher: "", lang: "de", quote: "Ein neuer Beleg." });
      file.areas = file.areas.filter((a) => a.key !== "vrachos");

      const report = await importAreaFile(db, file, cfg, day);
      expect(report.updated.sort()).toEqual(["teranos-gulf", "velani-coast"]);
      expect(report.unchanged).toEqual([]);
      expect(report.ended).toEqual(["vrachos"]);

      const after = await counts(db, [velani.id, teranos.id]);
      expect(after.names).toBe(before.names + 1);
      expect(after.evidence).toBe(before.evidence + 1);
      expect(after.members).toBe(before.members - 1);
      expect((await members(db, velani.id)).map((m) => m.geo_object_id)).not.toContain(scene.objects.myrtidi);

      const ended = (await area(db, "vrachos"))!;
      expect(ended.valid_to).toBe(day);
      expect(await links(db, ended.id)).toBe(0);
    }));

  it("ends import names missing from the file and moves the preferred name to the file's choice", () =>
    withRollback(async (db) => {
      await insertScene(db);
      const day = await today(db);
      await importAreaFile(db, sceneFile(), cfg, day);
      const file = sceneFile();
      const v = file.areas.find((a) => a.key === "velani-coast")!;
      v.names = [
        { lang: "en", name: "Velani Coast", preferred: false },
        { lang: "en", name: "Velani Riviera", preferred: true },
      ];
      const report = await importAreaFile(db, file, cfg, day);
      expect(report.updated).toEqual(["velani-coast"]);
      const velani = (await area(db, "velani-coast"))!;
      const imported = (await names(db, velani.id)).filter((n) => n.origin === "import");
      expect(imported).toEqual([
        { name: "Ακτή Βελάνης", language: "el", origin: "import", is_preferred: true, valid: false },
        { name: "Velani Coast", language: "en", origin: "import", is_preferred: false, valid: true },
        { name: "Velani Riviera", language: "en", origin: "import", is_preferred: true, valid: true },
      ]);
    }));

  it("reports an area with one resolvable member as waiting and creates no geo object", () =>
    withRollback(async (db) => {
      await insertScene(db);
      const file = {
        ...sceneFile(),
        areas: [
          sceneArea("lonely", {
            members: [
              ["Velani", "harbour"],
              ["Nowhere", "harbour"],
            ],
          }),
        ],
      };
      const report = await importAreaFile(db, file, cfg, await today(db));
      expect(report.waiting).toEqual([{ key: "lonely", resolved: 1, unresolved: ["Nowhere"] }]);
      expect(report.created).toEqual([]);
      expect(await area(db, "lonely")).toBeUndefined();
    }));

  it("takes over a pilot area by its alias: same id and public id, new config key, bot names (Review Focus 5)", () =>
    withRollback(async (db) => {
      await insertScene(db);
      const publicId = newPublicId("ar");
      const [pilot] = await db
        .insert(geoObjects)
        .values({
          type: "area",
          origin: "manual",
          configKey: "saronic",
          publicId,
          geom: sql`ST_Multi(ST_MakeEnvelope(10.1, 40.1, 10.4, 40.4, 4326))`,
        })
        .returning({ id: geoObjects.id });
      await addNames(db, pilot!.id, [{ name: "Saronischer Golf", language: "de", origin: "manual", isPreferred: true }]);
      const file = {
        ...sceneFile(),
        areas: [
          sceneArea("saronic-gulf", {
            names: [
              { lang: "en", name: "Saronic Gulf", preferred: true },
              { lang: "de", name: "Saronischer Golf", preferred: true },
            ],
            members: [
              ["Velani", "harbour"],
              ["Dorkasi", "harbour"],
            ],
          }),
        ],
      };
      const report = await importAreaFile(db, file, cfg, await today(db));
      expect(report.updated).toEqual(["saronic-gulf"]);
      expect(report.created).toEqual([]);
      const after = (await area(db, "saronic-gulf"))!;
      expect(after.id).toBe(pilot!.id);
      expect(after.public_id).toBe(publicId);
      expect(after.valid_to).toBeNull();
      expect(after.tags).toMatchObject({ importCountry: SCENE_COUNTRY, polygonOrigin: "computed" });
      expect(await area(db, "saronic")).toBeUndefined();
      const all = await names(db, pilot!.id);
      expect(all).toContainEqual({ name: "Saronic Gulf", language: "en", origin: "import", is_preferred: true, valid: true });
      expect(all).toContainEqual({ name: "Saronischer Golf", language: "de", origin: "import", is_preferred: true, valid: true });
      expect(all).toContainEqual({ name: "Saronischer Golf", language: "de", origin: "manual", is_preferred: false, valid: true });
    }));

  it("gives a dropped and re-added key its ended area back: same id and public id, valid, linked to tiles", () =>
    withRollback(async (db) => {
      await insertScene(db);
      const day = await today(db);
      await importAreaFile(db, sceneFile(), cfg, day);
      const before = (await area(db, "vrachos"))!;
      const dropped = { ...sceneFile(), areas: sceneFile().areas.filter((a) => a.key !== "vrachos") };
      expect((await importAreaFile(db, dropped, cfg, day)).ended).toEqual(["vrachos"]);
      expect(await links(db, before.id)).toBe(0);

      const report = await importAreaFile(db, sceneFile(), cfg, day);
      expect(report.created).toEqual([]);
      expect(report.updated).toEqual(["vrachos"]);
      const after = (await area(db, "vrachos"))!;
      expect(after.id).toBe(before.id);
      expect(after.public_id).toBe(before.public_id);
      expect(after.valid_to).toBeNull();
      expect(await links(db, after.id)).toBeGreaterThan(0);
    }));

  it("keeps polygon and members of an area whose members no longer give a polygon", () =>
    withRollback(async (db) => {
      await insertScene(db);
      const day = await today(db);
      await importAreaFile(db, sceneFile(), cfg, day);
      const velani = (await area(db, "velani-coast"))!;
      const membersBefore = await members(db, velani.id);
      const file = sceneFile();
      const v = file.areas.find((a) => a.key === "velani-coast")!;
      v.members = [{ name: "Velani", type: "harbour" }];
      v.boundaryPoints = [{ name: "Nowhere", type: "cape" }];
      const report = await importAreaFile(db, file, cfg, day);
      expect(report.updated).toEqual(["velani-coast"]);
      expect(report.waiting).toEqual([]);
      expect(await members(db, velani.id)).toEqual(membersBefore);
      const after = (await area(db, "velani-coast"))!;
      expect(after.tags).toMatchObject({
        polygonOrigin: "computed",
        unresolvedMembers: [{ name: "Nowhere", type: "cape", role: "boundary" }],
      });
    }));

  it("does not take over a valid area another country's file imported: a conflict, by key or by alias", () =>
    withRollback(async (db) => {
      await insertScene(db);
      const other = (configKey: string) =>
        db
          .insert(geoObjects)
          .values({
            type: "area",
            origin: "import",
            configKey,
            publicId: newPublicId("ar"),
            tags: { importCountry: "XY" },
            geom: sql`ST_Multi(ST_MakeEnvelope(10.1, 40.1, 10.4, 40.4, 4326))`,
          })
          .returning({ id: geoObjects.id });
      const [byKey] = await other("velani-coast");
      const [byAlias] = await other("saronic");
      const file = sceneFile();
      file.areas.push(sceneArea("saronic-gulf", { members: [["Velani", "harbour"], ["Dorkasi", "harbour"]] }));
      const report = await importAreaFile(db, file, cfg, await today(db));
      expect(report.conflicts).toEqual([
        { key: "velani-coast", otherCountry: "XY" },
        { key: "saronic-gulf", otherCountry: "XY" },
      ]);
      expect([...report.created, ...report.updated, ...report.unchanged]).not.toContain("velani-coast");
      expect([...report.created, ...report.updated, ...report.unchanged]).not.toContain("saronic-gulf");
      for (const [key, row] of [["velani-coast", byKey], ["saronic", byAlias]] as const) {
        const after = (await area(db, key))!;
        expect(after.id).toBe(row!.id);
        expect(after.tags).toEqual({ importCountry: "XY" });
        expect(after.valid_to).toBeNull();
      }
    }));
});
