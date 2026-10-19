import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ChangeEntry, SpotBody } from "@/contract";
import { changeEntrySchema } from "@/contract/v1";
import { TEIL_B_EXAMPLE } from "@/contract/__tests__/fixtures";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { changeEvents, geoObjects, type ChangeSeverity, type ChangeType } from "@/lib/db/schema";
import { testDb, withRollback } from "@/test/db";
import {
  buildChanges,
  changedFields,
  contractSeverity,
  eventSeverities,
  FIELD_LABELS_DE,
  mergeChanges,
  type ObjectEvents,
} from "../changes";
import { openBuildSnapshot, type BuildSnapshot } from "../snapshot";
import { assignVersions, contentHash, type DeliveredEntry } from "../versioning";

const cfg = loadConfig("config").delivery;
const BODY: SpotBody = Object.fromEntries(
  Object.entries(TEIL_B_EXAMPLE).filter(([k]) => k !== "profileVersion" && k !== "validFrom"),
) as SpotBody;
const SP = BODY.id;
const GEO = "01a15602-0000-7000-8000-000000000001";
const TODAY = "2026-10-20";

const entry = (body: object, patch: Partial<DeliveredEntry> = {}): DeliveredEntry => ({
  type: "spot",
  geoObjectId: GEO,
  profileVersion: 2,
  contentHash: contentHash(body),
  validFrom: "2026-10-01",
  removed: false,
  ...patch,
});

/** The changes of one spot from `before` (delivered at version 2) to `after`. */
function changesOf(before: SpotBody | null, after: SpotBody | null, events = new Map<string, ObjectEvents>()): ChangeEntry[] {
  const latest = new Map(before ? [[SP, entry(before)]] : []);
  const { objects, removed } = assignVersions(after ? [{ type: "spot", id: SP, geoObjectId: GEO, body: after }] : [], latest, TODAY);
  return buildChanges({ objects, removed, previousBodies: new Map(before ? [[SP, before]] : []), eventSeverity: events, cfg: cfg.severity });
}

const sectors = (n: number): SpotBody => ({ ...BODY, shelter: { ...BODY.shelter, sectors: { ...BODY.shelter.sectors, N: n } } });

describe("changedFields", () => {
  it("lists leaf paths down to depth 3, arrays as leaves, without the version fields, sorted", () => {
    const after = {
      ...TEIL_B_EXAMPLE,
      profileVersion: 9,
      validFrom: "2026-10-20",
      shelter: { ...BODY.shelter, sectors: { ...BODY.shelter.sectors, N: 0.5 } },
      services: { ...BODY.services!, taverna: "yes" as const },
      limits: { ...BODY.limits, maxDraft: 3 },
      seasonNote: [{ months: [7], text: "Neu" }],
      provenance: { ...BODY.provenance, "services.taverna": { source: "observed" as const, confidence: 1, observedAt: null } },
    };
    expect(changedFields(TEIL_B_EXAMPLE, after)).toEqual([
      "limits.maxDraft",
      // a provenance key holds a dot: provenance › services.taverna › source is depth 3
      "provenance.services.taverna.confidence",
      "provenance.services.taverna.observedAt",
      "provenance.services.taverna.source",
      "seasonNote",
      "services.taverna",
      "shelter.sectors.N",
    ]);
  });

  it("null and an absent field are the same: no field, no new version (feed review M-1)", () => {
    const withNull = { ...BODY, mergedInto: null, limits: { ...BODY.limits, maxLength: null } } as unknown as SpotBody;
    const withoutBoth = { ...BODY, limits: { ...BODY.limits } } as SpotBody;
    delete (withoutBoth as { mergedInto?: unknown }).mergedInto;
    delete (withoutBoth.limits as { maxLength?: unknown }).maxLength;
    expect(changedFields(withNull, withoutBoth)).toEqual([]);
    expect(contentHash(withNull)).toBe(contentHash(withoutBoth));
    expect(changesOf(withNull, withoutBoth)).toEqual([]);
  });

  it("a field present on one side only is one leaf", () => {
    const withoutDepth = { ...BODY, depth: undefined };
    expect(changedFields(withoutDepth, BODY)).toEqual(["depth"]);
    expect(changedFields(BODY, BODY)).toEqual([]);
  });
});

describe("contractSeverity", () => {
  it.each([
    [["shelter.sectors.N"], 0.6, 0.35, "safety"],
    [["shelter.sectors.N"], 0.6, 0.45, "info"],
    [["shelter.sectors.N"], 0.6, 0.4, "info"],
    [["limits.maxDraft"], null, null, "safety"],
    [["exclude.excluded"], null, null, "safety"],
    [["hazards"], null, null, "safety"],
    [["services.water"], null, null, "notable"],
    [["highlightIds"], null, null, "notable"],
    [["berth.status", "holding"], null, null, "notable"],
    [["holding"], null, null, "info"],
    [["shelter.swell"], null, null, "info"],
  ] as Array<[string[], number | null, number | null, ChangeSeverity]>)("contract severity of %j", (fields, before, after, expected) => {
    const body = (n: number | null) => (n === null ? null : { shelter: { sectors: { N: n } } });
    expect(contractSeverity(fields, body(before), body(after), cfg.severity)).toBe(expected);
  });

  it("a sector whose old or new value is unknown counts as a safety change", () => {
    expect(contractSeverity(["shelter.sectors.N"], null, { shelter: { sectors: { N: 0.5 } } }, cfg.severity)).toBe("safety");
  });
});

describe("buildChanges", () => {
  it("an unchanged object has no entry, a new one is created, a missing one removed", () => {
    expect(changesOf(BODY, BODY)).toEqual([]);
    expect(changesOf(null, BODY)).toEqual([
      { objectType: "spot", objectId: SP, event: "created", fields: [], severity: "info", summary: { de: "Neu im Paket." }, profileVersion: 1 },
    ]);
    expect(changesOf(BODY, null)).toEqual([
      { objectType: "spot", objectId: SP, event: "removed", fields: [], severity: "notable", summary: { de: "Nicht mehr im Paket." }, profileVersion: 3 },
    ]);
  });

  it("an update lists its fields and labels them in the summary", () => {
    const [e] = changesOf(BODY, { ...sectors(0.3), services: { ...BODY.services!, water: "yes" } });
    expect(e).toEqual({
      objectType: "spot",
      objectId: SP,
      event: "updated",
      fields: ["services.water", "shelter.sectors.N"],
      severity: "safety",
      summary: { de: "Geändert: Versorgung, Schutz." },
      profileVersion: 3,
    });
    expect(changeEntrySchema.safeParse(e).success).toBe(true);
  });

  it("an event severity safety from change_events wins over info", () => {
    const after = { ...BODY, depth: { ...BODY.depth!, min: 1 } };
    expect(changesOf(BODY, after)[0]).toMatchObject({ event: "updated", fields: ["depth.min"], severity: "info" });
    const events = new Map([[GEO, { object: null, attributes: new Map<string, ChangeSeverity>([["depth.min", "safety"]]) }]]);
    expect(changesOf(BODY, after, events)[0]).toMatchObject({ severity: "safety" });
  });

  it("an attribute event raises only a change of a field it feeds; object events always count (ruling M6-P2)", () => {
    const after = { ...BODY, depth: { ...BODY.depth!, min: 1 } };
    const unrelated = new Map([[GEO, { object: null, attributes: new Map<string, ChangeSeverity>([["services.waste", "safety"], ["max_draft", "notable"]]) }]]);
    expect(changesOf(BODY, after, unrelated)[0]).toMatchObject({ severity: "info" });
    const object = new Map([[GEO, { object: "notable" as const, attributes: new Map<string, ChangeSeverity>() }]]);
    expect(changesOf(BODY, after, object)[0]).toMatchObject({ severity: "notable" });
    expect(changesOf(null, BODY, object)[0]).toMatchObject({ event: "created", severity: "notable" });
  });

  it("exclude false → true is event excluded with summary 'Ausgeschlossen: Militärisches Sperrgebiet.'", () => {
    const after: SpotBody = { ...BODY, exclude: { excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" } };
    expect(changesOf(BODY, after)).toEqual([
      {
        objectType: "spot",
        objectId: SP,
        event: "excluded",
        fields: [],
        severity: "safety",
        summary: { de: "Ausgeschlossen: Militärisches Sperrgebiet." },
        profileVersion: 3,
      },
    ]);
  });

  it("a newly set mergedInto is event merged, at least notable", () => {
    const target = "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z9";
    expect(changesOf(BODY, { ...BODY, mergedInto: target })).toEqual([
      expect.objectContaining({ event: "merged", fields: [], severity: "notable", summary: { de: `Zusammengelegt mit ${target}.` } }),
    ]);
  });

  it("a spot created already excluded is safety; clearing mergedInto is an info update (feed review M-6)", () => {
    const excluded: SpotBody = { ...BODY, exclude: { excluded: true, reason: "military", detail: null } };
    expect(changesOf(null, excluded)[0]).toMatchObject({ event: "created", severity: "safety" });
    const merged: SpotBody = { ...BODY, mergedInto: "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z9" };
    expect(changesOf(merged, BODY)).toEqual([
      expect.objectContaining({ event: "updated", fields: ["mergedInto"], severity: "info", summary: { de: "Geändert: Zusammenlegung." } }),
    ]);
  });

  it("entries are sorted by object type and id", () => {
    const hl = "hl_01J9X4KQ3P2N1M0Z9K8J7H6G5F";
    const spots = ["sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z5", "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z1"];
    const drafts = [
      ...spots.map((id) => ({ type: "spot" as const, id, geoObjectId: null, body: { ...BODY, id } })),
      { type: "highlight" as const, id: hl, geoObjectId: null, body: { ...BODY, id: hl } as never },
    ];
    const { objects, removed } = assignVersions(drafts, new Map(), TODAY);
    const out = buildChanges({ objects, removed, previousBodies: new Map(), eventSeverity: new Map(), cfg: cfg.severity });
    expect(out.map((e) => e.objectId)).toEqual([hl, spots[1], spots[0]]);
  });

  it("an update without the previous body is an error", () => {
    const { objects, removed } = assignVersions([{ type: "spot", id: SP, geoObjectId: GEO, body: sectors(0.1) }], new Map([[SP, entry(BODY)]]), TODAY);
    expect(() => buildChanges({ objects, removed, previousBodies: new Map(), eventSeverity: new Map(), cfg: cfg.severity })).toThrow(/previous body/);
  });

  it("every first-level contract field has a German label", () => {
    for (const key of Object.keys(TEIL_B_EXAMPLE)) {
      if (key === "profileVersion" || key === "validFrom") continue;
      expect(FIELD_LABELS_DE[key as keyof typeof FIELD_LABELS_DE]).toMatch(/\S/);
    }
  });
});

describe("mergeChanges", () => {
  const e = (objectId: string, event: ChangeEntry["event"], profileVersion: number, patch: Partial<ChangeEntry> = {}): ChangeEntry => ({
    objectType: "spot",
    objectId,
    event,
    fields: [],
    severity: "info",
    summary: { de: event },
    profileVersion,
    ...patch,
  });
  const A = "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z1";
  const B = "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z2";
  const C = "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z3";
  const D = "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z4";

  it("mergeChanges: created then updated is created, created then removed disappears, fields are united", () => {
    const merged = mergeChanges([
      [e(A, "created", 1, { summary: { de: "Neu im Paket." } }), e(B, "created", 1), e(C, "updated", 4, { fields: ["holding"] }), e(D, "removed", 3)],
      [e(A, "updated", 2, { fields: ["shelter.sectors.N"], severity: "safety" }), e(B, "removed", 2), e(C, "updated", 5, { fields: ["depth.min", "holding"], severity: "notable" })],
      [e(D, "created", 4)],
    ]);
    expect(merged).toEqual([
      e(A, "created", 2, { severity: "safety", summary: { de: "Neu im Paket." } }),
      e(C, "updated", 5, { fields: ["depth.min", "holding"], severity: "notable" }),
      e(D, "created", 4),
    ]);
  });

  it("removed then created again is created for a client that had the object; removed at the end stays removed (feed review M-2)", () => {
    expect(
      mergeChanges([
        [e(A, "updated", 2, { fields: ["holding"] })],
        [e(A, "removed", 3, { severity: "notable" })],
        [e(A, "created", 4, { summary: { de: "Neu im Paket." } })],
        [e(A, "updated", 5, { fields: ["depth.min"], summary: { de: "Geändert: Tiefe." } })],
      ]),
    ).toEqual([e(A, "created", 5, { severity: "notable", summary: { de: "Neu im Paket." } })]);
    expect(mergeChanges([[e(A, "removed", 3)], [e(A, "created", 4)], [e(A, "removed", 5, { severity: "notable" })]])).toEqual([
      e(A, "removed", 5, { severity: "notable" }),
    ]);
    expect(mergeChanges([[e(A, "created", 1)], [e(A, "removed", 2)], [e(A, "created", 3)], [e(A, "removed", 4)]])).toEqual([]);
  });

  it("the last event wins otherwise, with the highest severity and the last version", () => {
    expect(mergeChanges([[e(A, "updated", 2, { fields: ["exclude"], severity: "safety" })], [e(A, "excluded", 3, { severity: "notable" })]])).toEqual([
      e(A, "excluded", 3, { severity: "safety" }),
    ]);
    expect(mergeChanges([[e(A, "updated", 2, { fields: ["holding"] })], [e(A, "removed", 3, { severity: "notable" })]])).toEqual([
      e(A, "removed", 3, { severity: "notable" }),
    ]);
  });
});

describe("eventSeverities", () => {
  async function insertObject(tx: Db): Promise<string> {
    const [row] = await tx
      .insert(geoObjects)
      .values({ type: "islet", origin: "manual", geom: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
      .returning({ id: geoObjects.id });
    return row!.id;
  }
  /** An event written by transaction `xid` (or by this one). */
  const event = (geoObjectId: string, type: ChangeType, attribute: string | null, severity: ChangeSeverity, xid?: bigint) => ({
    geoObjectId,
    type,
    attribute,
    severity,
    ...(xid === undefined ? {} : { xactId: sql`${String(xid)}::xid8` as unknown as string }),
  });
  /** A transaction id taken from the database, so no test depends on how far the xid counter is. */
  async function baseXid(tx: Db): Promise<bigint> {
    const { rows } = await tx.execute<{ xmax: string }>(sql`select pg_snapshot_xmax(pg_current_snapshot())::text as xmax`);
    return BigInt(rows[0]!.xmax);
  }
  const snap = (xmin: bigint, xmax: bigint, xip: bigint[] = []) => `${xmin}:${xmax}:${xip.join(",")}`;

  it("reads the events visible in this snapshot and not in the previous one, applied types only, the highest severity per attribute", async () => {
    await withRollback(async (tx) => {
      const a = await insertObject(tx);
      const b = await insertObject(tx);
      const x = await baseXid(tx);
      await tx.insert(changeEvents).values([
        event(a, "changed", "depth.min", "notable", x + 10n),
        event(a, "changed", "depth.min", "safety", x + 15n),
        event(a, "new_attribute", "holding", "info", x + 16n),
        event(a, "geo_changed", "geo.name", "info", x + 17n),
        event(a, "place_new", null, "notable", x + 19n),
        // uncertain and expired keep the delivered value (ruling M6-P2)
        event(a, "uncertain", "hazards", "safety", x + 18n),
        event(a, "expired", "limits", "safety", x + 18n),
        // seen by the previous package, in flight at this one, after this one
        event(a, "changed", "exclude", "safety", x + 9n),
        event(a, "changed", "exclude", "safety", x + 21n),
        event(a, "changed", "exclude", "safety", x + 25n),
        // committed after the previous package although above this one's xmin: visible here
        event(a, "changed", "seabed", "notable", x + 22n),
        event(b, "changed", "hazards", "safety", x + 15n),
      ]);
      const out = await eventSeverities(tx, [a], { fromSnapshot: snap(x + 10n, x + 10n), toSnapshot: snap(x + 20n, x + 25n, [x + 21n]) });
      expect([...out.keys()]).toEqual([a]);
      expect(out.get(a)!.object).toBe("notable");
      expect(Object.fromEntries(out.get(a)!.attributes)).toEqual({ "depth.min": "safety", holding: "info", seabed: "notable" });
    });
  });

  it("the first package uses no events", async () => {
    await withRollback(async (tx) => {
      const a = await insertObject(tx);
      const x = await baseXid(tx);
      await tx.insert(changeEvents).values([event(a, "changed", "holding", "info", x - 1n)]);
      expect((await eventSeverities(tx, [a], { fromSnapshot: null, toSnapshot: snap(x, x) })).size).toBe(0);
    });
  });

  it("a transaction above the build's xmin that committed before the build lands in that package's window (ruling M6-D-R3)", async () => {
    const db = testDb();
    const xid = async (tx: Db) => BigInt((await tx.execute<{ x: string }>(sql`select pg_current_xact_id()::text as x`)).rows[0]!.x);
    const { snapshot: previous } = await openBuildSnapshot(db, async () => null);

    // A long transaction A holds the xmin down; B starts after it and commits before the build. Neither writes a row.
    let releaseA!: () => void;
    const held = new Promise<void>((resolve) => (releaseA = resolve));
    let startedA!: (x: bigint) => void;
    const xidA = new Promise<bigint>((resolve) => (startedA = resolve));
    const a = db.transaction(async (tx) => {
      startedA(await xid(tx));
      await held;
    });
    let xidB: bigint;
    let build: BuildSnapshot;
    try {
      await xidA;
      xidB = await db.transaction(xid);
      build = (await openBuildSnapshot(db, async () => null)).snapshot;
    } finally {
      releaseA();
      await a;
    }
    const { snapshot: next } = await openBuildSnapshot(db, async () => null);
    // The race the xmin window got wrong: B is at or above the build's xmin, yet the build sees it.
    expect(BigInt(build.xmin)).toBeLessThanOrEqual(await xidA);
    expect(xidB).toBeGreaterThanOrEqual(BigInt(build.xmin));

    await withRollback(async (tx) => {
      const geo = await insertObject(tx);
      await tx.insert(changeEvents).values([event(geo, "changed", "hazards", "safety", xidB), event(geo, "changed", "holding", "notable", await xidA)]);
      const windowN = await eventSeverities(tx, [geo], { fromSnapshot: previous.snapshot, toSnapshot: build.snapshot });
      expect(Object.fromEntries(windowN.get(geo)!.attributes)).toEqual({ hazards: "safety" });
      const windowNext = await eventSeverities(tx, [geo], { fromSnapshot: build.snapshot, toSnapshot: next.snapshot });
      expect(Object.fromEntries(windowNext.get(geo)!.attributes)).toEqual({ holding: "notable" });
    });
  });
});

describe("openBuildSnapshot", () => {
  it("reads in one REPEATABLE READ read-only transaction whose snapshot it returns", async () => {
    const db = testDb();
    const { snapshot, result } = await openBuildSnapshot(db, async (tx, s) => {
      // a transaction committing meanwhile does not move the snapshot
      await db.transaction(async (other) => {
        await other.execute(sql`select pg_current_xact_id()`);
      });
      const { rows } = await tx.execute<{ iso: string; ro: string; snap: string; xmin: string }>(
        sql`select current_setting('transaction_isolation') as iso, current_setting('transaction_read_only') as ro,
                   pg_current_snapshot()::text as snap, pg_snapshot_xmin(pg_current_snapshot())::text as xmin`,
      );
      return { ...rows[0]!, passed: s };
    });
    expect(result).toEqual({ iso: "repeatable read", ro: "on", snap: snapshot.snapshot, xmin: snapshot.xmin, passed: snapshot });
    expect(snapshot.snapshot).toMatch(/^\d+:\d+:[\d,]*$/);
  });

  it("refuses a transaction handle", async () => {
    await withRollback(async (tx) => {
      await expect(openBuildSnapshot(tx, async () => null)).rejects.toThrow(/pool handle/);
    });
  });
});
