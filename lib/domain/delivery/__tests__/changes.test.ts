import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ChangeEntry, SpotBody } from "@/contract";
import { changeEntrySchema } from "@/contract/v1";
import { TEIL_B_EXAMPLE } from "@/contract/__tests__/fixtures";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { changeEvents, geoObjects, type ChangeSeverity, type ChangeType } from "@/lib/db/schema";
import { withRollback } from "@/test/db";
import {
  buildChanges,
  changedFields,
  contractSeverity,
  eventSeverities,
  FIELD_LABELS_DE,
  mergeChanges,
  type ObjectEvents,
} from "../changes";
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
  /** An event of a long-settled transaction `xid` (far below every snapshot's xmin), or of this one. */
  const event = (geoObjectId: string, type: ChangeType, attribute: string | null, severity: ChangeSeverity, xid?: number) => ({
    geoObjectId,
    type,
    attribute,
    severity,
    ...(xid === undefined ? {} : { xactId: sql`${String(xid)}::xid8` as unknown as string }),
  });

  it("reads the window fromXmin ≤ xact_id < toXmin, applied event types only, the highest severity per attribute", async () => {
    await withRollback(async (tx) => {
      const a = await insertObject(tx);
      const b = await insertObject(tx);
      await tx.insert(changeEvents).values([
        event(a, "changed", "depth.min", "notable", 1000),
        event(a, "changed", "depth.min", "safety", 1001),
        event(a, "new_attribute", "holding", "info", 1002),
        event(a, "geo_changed", "geo.name", "info", 1003),
        event(a, "place_new", null, "notable", 1004),
        // uncertain and expired keep the delivered value (ruling M6-P2)
        event(a, "uncertain", "hazards", "safety", 1005),
        event(a, "expired", "limits", "safety", 1006),
        // outside the window
        event(a, "changed", "exclude", "safety", 999),
        event(a, "changed", "exclude", "safety", 1100),
        event(b, "changed", "hazards", "safety", 1050),
      ]);
      const out = await eventSeverities(tx, [a], { fromXmin: "1000", toXmin: "1100" });
      expect([...out.keys()]).toEqual([a]);
      expect(out.get(a)!.object).toBe("notable");
      expect(Object.fromEntries(out.get(a)!.attributes)).toEqual({ "depth.min": "safety", holding: "info" });
    });
  });

  it("an event of a transaction still in flight is not counted, the first package uses no events (ruling M6-P1)", async () => {
    await withRollback(async (tx) => {
      const a = await insertObject(tx);
      await tx.insert(changeEvents).values([event(a, "changed", "hazards", "safety"), event(a, "changed", "holding", "info", 1000)]);
      const out = await eventSeverities(tx, [a], { fromXmin: "1", toXmin: "18446744073709551615" });
      expect(Object.fromEntries(out.get(a)!.attributes)).toEqual({ holding: "info" });
      expect((await eventSeverities(tx, [a], { fromXmin: null, toXmin: "18446744073709551615" })).size).toBe(0);
    });
  });
});
