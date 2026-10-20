import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { changeEvents, deliveries, documents, documentVersions, geoObjects, places, type ChangeSeverity, type ChangeType } from "@/lib/db/schema";
import { newId, newPublicId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import type { RevisitScenario } from "@/lib/domain/revisit/scenario";
import { asOfPlan, attributeMatches, checkAsOf, readSimMeta, verifyRevisit } from "@/lib/domain/revisit/verify";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSource, insertTestTile } from "@/test/text";

/*
 * verifyRevisit, asOfPlan and checkAsOf on rows inserted directly (withRollback): a one-tile area on a random tile of
 * the synthetic grid far from every other test box (−150…−145° E, −60…−55° N), its change events written by hand.
 */

type Area = { areaKey: string; areaId: string; tileId: string; spot: { geoObjectId: string; publicId: string }; other: { geoObjectId: string; publicId: string } };

async function seedArea(tx: Db): Promise<Area> {
  const col = 120 + Math.floor(Math.random() * 20);
  const row = 120 + Math.floor(Math.random() * 20);
  const lon = col * 0.25 - 180 + 0.125;
  const lat = row * 0.25 - 90 + 0.125;
  const areaKey = `verify-${newId()}`;
  const [area] = await tx
    .insert(geoObjects)
    .values({ type: "area", origin: "manual", geom: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }), publicId: newPublicId("ar"), configKey: areaKey })
    .returning({ id: geoObjects.id });
  const tileId = await insertTestTile(tx, `q025:${col}:${row}`, area!.id);
  const place = async (dx: number) => {
    const geoObjectId = await insertNamedObject(tx, { type: "bay", names: [{ name: `Bucht ${dx}` }], lon: lon + dx, lat, tiles: [tileId] });
    const publicId = newPublicId("sp");
    await tx.insert(places).values({ geoObjectId, kind: "anchorage", status: "confirmed", publicId, position: geomFromGeoJson({ type: "Point", coordinates: [lon + dx, lat] }) });
    return { geoObjectId, publicId };
  };
  return { areaKey, areaId: area!.id, tileId, spot: await place(0.01), other: await place(0.02) };
}

async function maxSeq(tx: Db): Promise<number> {
  const { rows } = await tx.execute<{ seq: string | null }>(sql`select max(seq)::text as seq from change_events`);
  return Number(rows[0]?.seq ?? 0);
}

async function event(tx: Db, geoObjectId: string, attribute: string | null, type: ChangeType, severity: ChangeSeverity) {
  await tx.insert(changeEvents).values({ geoObjectId, attribute, type, severity, profileVersion: 2 });
}

/** A document on its own host with a recorded version and, for `simulated`, a simulated one written by a revisit run. */
async function page(tx: Db, outcome: "new_version" | "gone" | "unchanged"): Promise<string> {
  const sourceId = await insertTestSource(tx);
  const url = `https://${newId()}.test.invalid/page`;
  const [doc] = await tx
    .insert(documents)
    .values({ sourceId, url, urlNormalized: url, docType: "pilot_guide", status: outcome === "gone" ? "gone" : "active" })
    .returning({ id: documents.id });
  const version = (simulated: boolean, runId: string | null) => ({
    documentId: doc!.id,
    fetchedAt: new Date(),
    contentHash: newId(),
    rawHash: "r",
    rawKey: `archive/${doc!.id}/${newId()}.raw.md`,
    mdKey: `archive/${doc!.id}/${newId()}.md`,
    observedAt: "2026-06-01",
    observedAtBasis: "fetched" as const,
    docType: "pilot_guide" as const,
    converter: simulated ? "simulated" : "local",
    charCount: 10,
    simulated,
    runId,
  });
  await tx.insert(documentVersions).values(version(false, null));
  if (outcome === "new_version") {
    const { id: runId } = await createRun(tx, { kind: "revisit", scope: { type: "area", id: "test" }, stages: [], params: {}, triggeredBy: "test" });
    await tx.insert(documentVersions).values(version(true, runId));
  }
  return url;
}

function scenario(entries: RevisitScenario["entries"]): RevisitScenario {
  return { name: "verify", entries };
}

const replace = { op: "replace" as const, from: "a", to: "b" };

describe("attributeMatches", () => {
  it("depth.* matches depth.min but not draft", () => {
    expect(attributeMatches("depth.*", "depth.min")).toBe(true);
    expect(attributeMatches("depth.*", "depth.anchoring_max")).toBe(true);
    expect(attributeMatches("depth.*", "draft")).toBe(false);
    expect(attributeMatches("depth.*", "depth")).toBe(false);
    expect(attributeMatches("depth.*", null)).toBe(false);
    expect(attributeMatches(null, null)).toBe(true);
    expect(attributeMatches("depth.min", "depth.max")).toBe(false);
  });
});

describe("verifyRevisit", () => {
  it("all expected events and documents give 2 of 2 correct and pass", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      const fromSeq = await maxSeq(tx);
      const changed = await page(tx, "new_version");
      const gone = await page(tx, "gone");
      await event(tx, a.spot.geoObjectId, "highlight.food", "changed", "notable");
      const v = await verifyRevisit(
        tx,
        scenario([
          { id: "e1", url: changed, edit: replace, expect: { document: "new_version", events: [{ subject: a.spot.publicId, attribute: "highlight.food", type: "changed", severity: "notable" }] } },
          { id: "e2", url: gone, edit: { op: "gone" }, expect: { document: "gone", events: [] } },
        ]),
        { fromSeq, areaKey: a.areaKey },
      );
      expect(v).toMatchObject({ fromSeq, expected: 2, correct: 2, unexpected: [], passes: true });
      expect(v.entries).toEqual([
        { id: "e1", url: changed, document: { expected: "new_version", actual: "new_version" }, events: { expected: 1, matched: 1 }, ok: true },
        { id: "e2", url: gone, document: { expected: "gone", actual: "gone" }, events: { expected: 0, matched: 0 }, ok: true },
      ]);
    }));

  it("an extra event is unexpected and fails", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      const fromSeq = await maxSeq(tx);
      const changed = await page(tx, "new_version");
      await event(tx, a.spot.geoObjectId, "highlight.food", "changed", "notable");
      await event(tx, a.other.geoObjectId, "services.water", "expired", "notable");
      // an event of an object outside the area is not the area's
      const elsewhere = await insertNamedObject(tx, { type: "bay", names: [{ name: "Fern" }], lon: 0, lat: 0 });
      await event(tx, elsewhere, "holding", "changed", "info");
      const v = await verifyRevisit(
        tx,
        scenario([
          { id: "e1", url: changed, edit: replace, expect: { document: "new_version", events: [{ subject: a.spot.publicId, attribute: "highlight.food", type: "changed", severity: "notable" }] } },
        ]),
        { fromSeq, areaKey: a.areaKey },
      );
      expect(v.correct).toBe(1);
      expect(v.unexpected).toEqual([
        { seq: expect.any(Number), subject: a.other.publicId, attribute: "services.water", type: "expired", severity: "notable", oldValue: null, newValue: null },
      ]);
      expect(v.passes).toBe(false);
    }));

  it("a wrong severity is not correct", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      const fromSeq = await maxSeq(tx);
      const changed = await page(tx, "new_version");
      await event(tx, a.spot.geoObjectId, "depth.min", "changed", "notable");
      const v = await verifyRevisit(
        tx,
        scenario([{ id: "e1", url: changed, edit: replace, expect: { document: "new_version", events: [{ subject: a.spot.publicId, attribute: "depth.*", type: "changed", severity: "safety" }] } }]),
        { fromSeq, areaKey: a.areaKey },
      );
      expect(v.entries[0]).toMatchObject({ events: { expected: 1, matched: 0 }, ok: false });
      expect(v.unexpected.map((e) => [e.attribute, e.severity])).toEqual([["depth.min", "notable"]]);
      expect(v).toMatchObject({ correct: 0, passes: false });
    }));

  it("depth.* matches depth.min but not draft", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      const fromSeq = await maxSeq(tx);
      const changed = await page(tx, "new_version");
      await event(tx, a.spot.geoObjectId, "max_draft", "changed", "safety");
      await event(tx, a.spot.geoObjectId, "depth.min", "changed", "safety");
      const v = await verifyRevisit(
        tx,
        scenario([{ id: "e1", url: changed, edit: replace, expect: { document: "new_version", events: [{ subject: a.spot.publicId, attribute: "depth.*", type: "changed", severity: "safety" }] } }]),
        { fromSeq, areaKey: a.areaKey },
      );
      expect(v.entries[0]!.ok).toBe(true);
      expect(v.unexpected.map((e) => e.attribute)).toEqual(["max_draft"]);
    }));

  it("a duplicate event for the same expectation counts as unexpected", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      const fromSeq = await maxSeq(tx);
      const changed = await page(tx, "new_version");
      await event(tx, a.spot.geoObjectId, "prohibitions", "changed", "safety");
      await event(tx, a.spot.geoObjectId, "prohibitions", "changed", "safety");
      const v = await verifyRevisit(
        tx,
        scenario([{ id: "e1", url: changed, edit: replace, expect: { document: "new_version", events: [{ subject: a.spot.publicId, attribute: "prohibitions", type: "changed", severity: "safety" }] } }]),
        { fromSeq, areaKey: a.areaKey },
      );
      expect(v.entries[0]!.ok).toBe(true);
      expect(v.unexpected).toHaveLength(1);
      expect(v.passes).toBe(false);
    }));

  it("a document without a revisit version is unchanged, not new_version", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      const fromSeq = await maxSeq(tx);
      const url = await page(tx, "unchanged");
      const v = await verifyRevisit(tx, scenario([{ id: "e1", url, edit: replace, expect: { document: "new_version", events: [] } }]), { fromSeq, areaKey: a.areaKey });
      expect(v.entries[0]).toMatchObject({ document: { expected: "new_version", actual: "unchanged" }, ok: false });
      expect(v.passes).toBe(false);
    }));

  it("events before fromSeq do not count", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      await event(tx, a.spot.geoObjectId, "holding", "changed", "info");
      const fromSeq = await maxSeq(tx);
      const url = await page(tx, "unchanged");
      const v = await verifyRevisit(tx, scenario([{ id: "e1", url, edit: { op: "touch" }, expect: { document: "unchanged", events: [] } }]), { fromSeq, areaKey: a.areaKey });
      expect(v).toMatchObject({ correct: 1, unexpected: [], passes: true });
    }));
});

async function delivery(tx: Db, areaId: string, dataVersion: number, generatedAt: string, status: "valid" | "unchanged" = "valid") {
  await tx.insert(deliveries).values({
    areaId,
    dataVersion: status === "valid" ? dataVersion : null,
    schemaVersion: "1.0.0",
    generatedAt: new Date(generatedAt),
    status,
    storagePrefix: status === "unchanged" ? null : `deliveries/test/${newId()}/`,
    objectCounts: {},
    validationReport: { ok: true, checks: [] },
    changeSnapshot: sql`pg_current_snapshot()`,
    changeXmin: sql`pg_snapshot_xmin(pg_current_snapshot())`,
  });
}

async function revisitRun(tx: Db, areaKey: string, at: string) {
  const { id } = await createRun(tx, { kind: "revisit", scope: { type: "area", id: areaKey }, stages: [], params: {}, triggeredBy: "test" });
  await tx.execute(sql`update runs set created_at = ${at}::timestamptz where id = ${id}`);
}

describe("asOfPlan", () => {
  it("asOf check reports a same-day previous delivery", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      await delivery(tx, a.areaId, 1, "2026-06-01T06:00:00Z");
      await revisitRun(tx, a.areaKey, "2026-06-01T07:00:00Z");
      await delivery(tx, a.areaId, 2, "2026-06-01T18:00:00Z");
      expect(await asOfPlan(tx, a.areaKey)).toEqual({ reason: expect.stringMatching(/selben Tag/) });
    }));

  it("names a missing package before or after the revisit, and a missing revisit", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      expect(await asOfPlan(tx, a.areaKey)).toEqual({ reason: "Kein Revisit-Lauf für das Revier" });
      await revisitRun(tx, a.areaKey, "2026-06-01T07:00:00Z");
      expect(await asOfPlan(tx, a.areaKey)).toEqual({ reason: "Vor dem Revisit kein Paket gebaut" });
      await delivery(tx, a.areaId, 1, "2026-05-01T08:00:00Z");
      expect(await asOfPlan(tx, a.areaKey)).toEqual({ reason: "Nach dem Revisit kein Paket gebaut" });
      // an unchanged package after the revisit is no package of the new state
      await delivery(tx, a.areaId, 0, "2026-06-02T08:00:00Z", "unchanged");
      expect(await asOfPlan(tx, a.areaKey)).toEqual({ reason: "Nach dem Revisit kein Paket gebaut" });
    }));

  it("takes the latest valid packages around the first revisit and the day before the later one", () =>
    withRollback(async (tx) => {
      const a = await seedArea(tx);
      await delivery(tx, a.areaId, 1, "2026-04-20T08:00:00Z");
      await delivery(tx, a.areaId, 2, "2026-05-01T08:00:00Z");
      await revisitRun(tx, a.areaKey, "2026-06-01T07:00:00Z");
      await revisitRun(tx, a.areaKey, "2026-06-08T07:00:00Z");
      await delivery(tx, a.areaId, 3, "2026-06-08T08:00:00Z");
      expect(await asOfPlan(tx, a.areaKey)).toEqual({
        asOf: "2026-06-07",
        before: { dataVersion: 2, generatedAt: new Date("2026-05-01T08:00:00Z") },
        after: { dataVersion: 3, generatedAt: new Date("2026-06-08T08:00:00Z") },
      });
    }));
});

describe("checkAsOf", () => {
  const ok = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

  it("asOf check passes when the API returns the older profile version", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const stub: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ schemaVersion: "1.0.0", area: "ar_x", dataVersion: 1, spot: {} }), { status: 200 });
    };
    const result = await checkAsOf({ baseUrl: "http://localhost:3001/", key: "pk_test", spotId: "sp_01ABC", asOf: "2026-06-07", expectBefore: { dataVersion: 1 }, fetch: stub });
    expect(result).toEqual({ ok: true, status: 200, dataVersion: 1 });
    expect(seen).toEqual([{ url: "http://localhost:3001/api/v1/spots/sp_01ABC?asOf=2026-06-07", auth: "Bearer pk_test" }]);
  });

  it("fails on the newer version, a 404 and an unreachable API, never echoing the key", async () => {
    const newer = await checkAsOf({ baseUrl: "http://x", key: "pk_secret", spotId: "sp_1", asOf: "2026-06-07", expectBefore: { dataVersion: 1 }, fetch: ok({ dataVersion: 2 }) });
    expect(newer).toMatchObject({ ok: false, status: 200, dataVersion: 2, reason: expect.stringMatching(/2 statt 1/) });
    expect(await checkAsOf({ baseUrl: "http://x", key: "pk_secret", spotId: "sp_1", asOf: "2026-06-07", expectBefore: { dataVersion: 1 }, fetch: ok({}, 404) })).toMatchObject({
      ok: false,
      status: 404,
      dataVersion: null,
    });
    const down = await checkAsOf({
      baseUrl: "http://x",
      key: "pk_secret",
      spotId: "sp_1",
      asOf: "2026-06-07",
      expectBefore: { dataVersion: 1 },
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(down).toMatchObject({ ok: false, status: 0 });
    expect(JSON.stringify([newer, down])).not.toContain("pk_secret");
  });
});

describe("readSimMeta", () => {
  it("is null without the table and reads the newest row with it", () =>
    withRollback(async (tx) => {
      expect(await readSimMeta(tx)).toBeNull();
      await tx.execute(sql`create table sim_meta (cloned_at timestamptz not null, source_db text not null, from_seq bigint not null)`);
      expect(await readSimMeta(tx)).toBeNull();
      await tx.execute(sql`insert into sim_meta values ('2026-06-01T06:00:00Z', 'periplus', 41), ('2026-06-02T06:00:00Z', 'periplus', 42)`);
      expect(await readSimMeta(tx)).toEqual({ clonedAt: new Date("2026-06-02T06:00:00Z"), sourceDb: "periplus", fromSeq: 42 });
    }));
});
