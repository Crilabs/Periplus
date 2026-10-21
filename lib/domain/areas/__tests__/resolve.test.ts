import { describe, expect, it } from "vitest";
import { resolveAreaMembers, scopeSubdivisionIds } from "@/lib/domain/areas/resolve";
import { withRollback } from "@/test/db";
import { insertScene, sceneConfig, SPLIT_PARENT } from "@/test/fixtures/areas/scene";

const cfg = sceneConfig();

describe("scopeSubdivisionIds", () => {
  it("expands a split parent to its groups and reports an unknown key (Review Focus 2)", () =>
    withRollback(async (db) => {
      const scene = await insertScene(db);
      const res = await scopeSubdivisionIds(db, [SPLIT_PARENT, "ZT-UNKNOWN"], cfg);
      expect(res.ids.sort()).toEqual([scene.subdivisions.a, scene.subdivisions.b].sort());
      expect(res.unknown).toEqual(["ZT-UNKNOWN"]);
      const plain = await scopeSubdivisionIds(db, ["ZT-A"], cfg);
      expect(plain).toEqual({ ids: [scene.subdivisions.a], unknown: [] });
    }));
});

describe("resolveAreaMembers", () => {
  it("resolves exact and transliterated names with the right type", () =>
    withRollback(async (db) => {
      const scene = await insertScene(db);
      const res = await resolveAreaMembers(
        db,
        [
          { name: "Velani", type: "harbour", role: "member" },
          { name: "Myrtidi", type: "harbour", role: "member" },
          { name: "Δορκάσι", type: "harbour", role: "member" },
          { name: "Kastelani", type: "harbour", role: "member" },
          { name: "Sarandi", type: "cape", role: "boundary" },
        ],
        [scene.subdivisions.a],
        cfg,
      );
      expect(res.unresolved).toEqual([]);
      expect(res.resolved).toEqual([
        { geoObjectId: scene.objects.velani, name: "Velani", type: "harbour", role: "member" },
        { geoObjectId: scene.objects.myrtidi, name: "Myrtidi", type: "harbour", role: "member" },
        { geoObjectId: scene.objects.dorkasi, name: "Δορκάσι", type: "harbour", role: "member" },
        { geoObjectId: scene.objects.kastelani, name: "Kastelani", type: "harbour", role: "member" },
        { geoObjectId: scene.objects.sarandi, name: "Sarandi", type: "cape", role: "boundary" },
      ]);
    }));

  it("leaves a name found twice in the scope unresolved (Review Focus 1)", () =>
    withRollback(async (db) => {
      const scene = await insertScene(db);
      const res = await resolveAreaMembers(
        db,
        [{ name: "Agios Stefanos", type: "harbour", role: "member" }],
        [scene.subdivisions.a, scene.subdivisions.b],
        cfg,
      );
      expect(res.resolved).toEqual([]);
      expect(res.unresolved).toEqual([{ name: "Agios Stefanos", type: "harbour", role: "member" }]);
    }));

  it("leaves the right name with the wrong type unresolved", () =>
    withRollback(async (db) => {
      const scene = await insertScene(db);
      const res = await resolveAreaMembers(
        db,
        [
          { name: "Kastelani", type: "cape", role: "boundary" },
          { name: "Velani", type: "island", role: "member" },
        ],
        [scene.subdivisions.a],
        cfg,
      );
      expect(res.resolved).toEqual([]);
      expect(res.unresolved.map((u) => u.name)).toEqual(["Kastelani", "Velani"]);
    }));

  it("finds a name one tile ring outside the subdivision, not two rings", () =>
    withRollback(async (db) => {
      const scene = await insertScene(db);
      const res = await resolveAreaMembers(
        db,
        [
          { name: "Plakari", type: "harbour", role: "member" },
          { name: "Xerolimni", type: "harbour", role: "member" },
        ],
        [scene.subdivisions.a],
        cfg,
      );
      expect(res.resolved).toEqual([{ geoObjectId: scene.objects.plakari, name: "Plakari", type: "harbour", role: "member" }]);
      expect(res.unresolved).toEqual([{ name: "Xerolimni", type: "harbour", role: "member" }]);
    }));

  it("prefers the bot type's own object type when a harbour and its town share the name", () =>
    withRollback(async (db) => {
      const scene = await insertScene(db);
      const res = await resolveAreaMembers(
        db,
        [
          { name: "Kalidona", type: "harbour", role: "member" },
          { name: "Kalidona", type: "settlement", role: "boundary" },
        ],
        [scene.subdivisions.a],
        cfg,
      );
      expect(res.resolved).toEqual([
        { geoObjectId: scene.objects.kalidonaHarbour, name: "Kalidona", type: "harbour", role: "member" },
        { geoObjectId: scene.objects.kalidonaTown, name: "Kalidona", type: "settlement", role: "boundary" },
      ]);
    }));

  it("resolves a member whose name is a configured common word", () =>
    withRollback(async (db) => {
      const scene = await insertScene(db);
      expect(cfg.mentions.commonWords.el).toContain("skala");
      const res = await resolveAreaMembers(db, [{ name: "Skala", type: "harbour", role: "member" }], [scene.subdivisions.a], cfg);
      expect(res.resolved).toEqual([{ geoObjectId: scene.objects.skala, name: "Skala", type: "harbour", role: "member" }]);
    }));
});
