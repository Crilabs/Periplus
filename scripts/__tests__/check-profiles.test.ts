import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { places, profileSummaries, reviewTasks, tileGeoObjects, tiles } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { newId } from "@/lib/domain/ids";
import { tileBbox } from "@/lib/domain/tiles";
import { insertPlace, insertProfileTask, insertSource, insertTextFact } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSubdivision } from "@/test/text";
import {
  assessProfiles,
  attributesWithoutProvenance,
  checkProfiles,
  parseArgs,
  profileCheckFailures,
  profileStats,
  type ProfileObjectStats,
  type ProfileStats,
} from "../check-profiles";

/**
 * A subdivision whose polygon lies inside its own coast tile, far from every other test grid (a random column near the
 * south pole), so the subdivision's run scope is that one tile and its objects are exactly the ones the test links to
 * it. Returns the subdivision key and the tile id.
 */
async function ownSubdivision(tx: Db): Promise<{ subdivisionKey: string; tileId: string }> {
  const subdivisionKey = `XT-${newId()}`;
  const tileId = `q025:${Math.floor(Math.random() * 1400)}:${3 + Math.floor(Math.random() * 5)}`;
  const [w, s, e, n] = tileBbox(tileId);
  const { id: subdivisionId } = await insertTestSubdivision(tx, subdivisionKey, [w + 0.01, s + 0.01, e - 0.01, n - 0.01]);
  await tx
    .insert(tiles)
    .values({ id: tileId, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, subdivisionId, hasCoast: true })
    .onConflictDoUpdate({ target: tiles.id, set: { subdivisionId, hasCoast: true, validTo: null } });
  await tx.delete(tileGeoObjects).where(sql`${tileGeoObjects.tileId} = ${tileId}`);
  return { subdivisionKey, tileId };
}

/** Today (UTC) plus `n` days, `YYYY-MM-DD`. */
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const link = (tx: Db, tileId: string, geoObjectId: string) => tx.insert(tileGeoObjects).values({ tileId, geoObjectId });

const object = (over: Partial<ProfileObjectStats> = {}): ProfileObjectStats => ({
  geoObjectId: newId(),
  name: "Kolona",
  level: "place",
  version: 1,
  attributesWithoutProvenance: [],
  summary: "ok",
  ...over,
});

const stats = (over: Partial<ProfileStats> = {}): ProfileStats => ({ objects: [object()], openConflicts: 0, openUncertain: 0, asOfProbes: [], ...over });

describe("check-profiles", () => {
  it("assessProfiles: a missing profile, an attribute without provenance and a wrong as-of version fail; open tasks only count", () => {
    const missing = object({ name: "Agia Marina", version: null, summary: null });
    const bare = object({ name: "Bare", attributesWithoutProvenance: ["holding"] });
    const island = object({ name: "Moni", level: "island", summary: "empty" });
    const result = assessProfiles(
      stats({
        objects: [island, bare, missing],
        openConflicts: 2,
        openUncertain: 1,
        asOfProbes: [{ geoObjectId: island.geoObjectId, date: "2026-10-09", expectedVersion: 1, gotVersion: 2 }],
      }),
    );
    expect(result).toEqual({
      objects: 3,
      withProfile: 2,
      missing: [{ geoObjectId: missing.geoObjectId, name: "Agia Marina", level: "place" }],
      withoutProvenance: [bare.geoObjectId],
      openConflicts: 2,
      openUncertain: 1,
      summaries: { ok: 1, empty: 1 },
      asOfCheck: false,
    });
    expect(profileCheckFailures(result)).toEqual([
      "1 object(s) without a profile",
      "1 profile(s) with an attribute without provenance, rule or cited input",
      "profileAsOf did not return the earlier version for the day before a later version",
    ]);
    // open conflicts and uncertain changes are reported, not failed; no probe means the as-of check passes
    expect(profileCheckFailures(assessProfiles(stats({ openConflicts: 3, openUncertain: 4 })))).toEqual([]);
    expect(assessProfiles(stats()).asOfCheck).toBe(true);
  });

  it("a subdivision without objects fails instead of passing on nothing (bundle J review M-1)", () => {
    expect(profileCheckFailures(assessProfiles(stats({ objects: [] })))).toEqual(["no objects in the subdivision (gazetteer built? coast tiles assigned?)"]);
  });

  it("attributesWithoutProvenance lists valued attributes without provenance or rule", () => {
    const prov = { rule: "holding", origin: "text", factIds: ["f1"], computationIds: [], poiIds: [] } as never;
    expect(
      attributesWithoutProvenance({ holding: "good", "shelter.N": 0.9, seabed: null, contact: { phone: "1" } }, { holding: prov, contact: { rule: "" } as never }),
    ).toEqual(["contact", "shelter.N"]);
  });

  it("a text, computed or review value must cite a fact, computation or POI; rule, gazetteer and derived values need not (bundle J review M-2)", () => {
    const entry = (origin: string, ids: { factIds?: string[]; computationIds?: string[]; poiIds?: string[] } = {}) =>
      ({ rule: "default", origin, factIds: [], computationIds: [], poiIds: [], ...ids }) as never;
    const attributes = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1 };
    expect(
      attributesWithoutProvenance(attributes, {
        a: entry("text"),
        b: entry("computed"),
        c: entry("review"),
        d: entry("text", { factIds: ["f"] }),
        e: entry("computed", { computationIds: ["c"] }),
        f: entry("text", { poiIds: ["p"] }),
        g: entry("rule"),
        h: entry("gazetteer"),
        i: entry("derived"),
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("parseArgs takes exactly --subdivision <key>", () => {
    expect(parseArgs(["--subdivision", "GR-I"])).toEqual({ subdivision: "GR-I" });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "--x"])).toThrow(/usage/);
  });

  it("a confirmed place without profile is missing", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, tileId } = await ownSubdivision(tx);
      const confirmed = await insertPlace(tx, { name: "Ohneprofil" });
      const candidate = await insertPlace(tx, { name: "Kandidat", status: "candidate" });
      const settlement = await insertNamedObject(tx, { type: "settlement", names: [{ name: "Dorf" }], lon: 21.0, lat: 35.2 });
      for (const id of [confirmed.objectId, candidate.objectId, settlement]) await link(tx, tileId, id);

      const r = await checkProfiles(tx, subdivisionKey);
      // the candidate place and the settlement take no profile check; the subdivision's own object lies outside the tile
      expect(r).toMatchObject({ objects: 1, withProfile: 0, withoutProvenance: [], asOfCheck: true });
      expect(r.missing).toEqual([{ geoObjectId: confirmed.objectId, name: "Ohneprofil", level: "place" }]);
      expect(profileCheckFailures(r)).toEqual(["1 object(s) without a profile"]);
    }));

  it("a subdivision whose objects all have profiles with provenance passes", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, tileId } = await ownSubdivision(tx);
      const place = await insertPlace(tx, { name: "Mitprofil" });
      const island = await insertNamedObject(tx, { type: "island", names: [{ name: "Insel" }], lon: 21.0, lat: 35.2 });
      for (const id of [place.objectId, island]) await link(tx, tileId, id);

      // version 1 today, version 2 with a text fact nine days later: the day before version 2 gives version 1
      // (geo objects are valid from today, so the run dates cannot lie earlier)
      await consolidateGeo(tx, place.objectId, { today: day(0) });
      await insertTextFact(tx, place.objectId, await insertSource(tx), { attribute: "holding", value: "good", confidence: 0.9 });
      expect(await consolidateGeo(tx, place.objectId, { today: day(9) })).toMatchObject({ status: "created", version: 2 });
      await consolidateGeo(tx, island, { today: day(9) });
      await tx.insert(profileSummaries).values({ geoObjectId: place.objectId, profileVersion: 2, text: "Eine Bucht.", status: "ok", attempts: 1, model: "m", promptVersion: 1 });
      await tx.insert(profileSummaries).values({ geoObjectId: island, profileVersion: 1, text: null, status: "empty", attempts: 3 });
      await insertProfileTask(tx, place.objectId, { kind: "conflict", attribute: "holding", key: "k1", status: "open" });
      await insertProfileTask(tx, place.objectId, { kind: "uncertain_change", attribute: "depth.min", key: "k2", status: "decided", action: "keep" });
      // „Eintrag entfernen“ writes uncertain_change tasks of subject type profile_entry: never counted (M5-I-R2 M-3)
      await tx.insert(reviewTasks).values({ kind: "uncertain_change", subjectType: "profile_entry", subjectId: `${place.objectId}:hazards`, context: {}, status: "open" });

      const r = await checkProfiles(tx, subdivisionKey);
      expect(r).toEqual({
        objects: 2,
        withProfile: 2,
        missing: [],
        withoutProvenance: [],
        openConflicts: 1,
        openUncertain: 0,
        summaries: { ok: 1, empty: 1 },
        asOfCheck: true,
      });
      expect(profileCheckFailures(r)).toEqual([]);
      // the as-of check really probed the place: the day before version 2 gives version 1
      expect((await profileStats(tx, subdivisionKey)).asOfProbes).toEqual([{ geoObjectId: place.objectId, date: day(8), expectedVersion: 1, gotVersion: 1 }]);
    }));

  it("an unknown subdivision is an error, and an area key names the subdivision to use instead", () =>
    withRollback(async (tx) => {
      await expect(checkProfiles(tx, `test-${newId()}`)).rejects.toThrow(/Unbekannter Landesteil/);
      await expect(checkProfiles(tx, "saronic")).rejects.toThrow(/Revier-Schlüssel saronic ist kein Laufumfang mehr/);
    }));

  it("places of another area or ended places do not count", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, tileId } = await ownSubdivision(tx);
      const ended = await insertPlace(tx, { name: "Beendet" });
      await tx.update(places).set({ validTo: "2026-01-01" }).where(sql`${places.id} = ${ended.placeId}`);
      await link(tx, tileId, ended.objectId);
      await insertPlace(tx, { name: "Woanders" }); // in no tile of the area
      expect(await checkProfiles(tx, subdivisionKey)).toMatchObject({ objects: 0, missing: [] });
    }));
});
