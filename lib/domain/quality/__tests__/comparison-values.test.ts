import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { COMPARISON_ATTRIBUTES, comparisonValues, type ComparisonSubject } from "../comparison-values";

const cfg = getConfig().quality.navily;

/** A confirmed anchorage at 21.12342° E / 35.2° N with the given profile attributes. */
function subject(attributes: Record<string, unknown>, patch: Partial<ComparisonSubject> = {}): ComparisonSubject {
  return {
    placeId: "0190a1b2-0000-7000-8000-000000000001",
    publicId: "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z1",
    name: "Kolona",
    names: ["Kolona"],
    kind: "anchorage",
    status: "confirmed",
    position: { lon: 21.12342, lat: 35.2 },
    anchorPosition: null,
    attributes,
    profileVersion: 1,
    ...patch,
  };
}

/** Degrees of longitude for `m` metres at 35.2° N. */
const lonMetres = (m: number) => m / (111_320 * Math.cos((35.2 * Math.PI) / 180));

describe("comparisonValues", () => {
  it("gives one value per compared attribute, hashed from attribute and normalised value only", () => {
    const values = comparisonValues(subject({ "shelter.N": 0.6 }), cfg);
    expect(Object.keys(values)).toEqual([...COMPARISON_ATTRIBUTES]);
    const expected = createHash("sha256").update(canonicalJson({ attribute: "shelter.N", value: { protected: true } })).digest("hex");
    expect(values["shelter.N"]).toEqual({ value: { protected: true }, display: "0,6 (geschützt)", hash: expected.slice(0, 16) });
    for (const v of Object.values(values)) expect(v.hash).toMatch(/^[0-9a-f]{16}$/);
    // the same value under another attribute hashes differently
    const s = comparisonValues(subject({ "shelter.N": 0.6, "shelter.S": 0.6 }), cfg);
    expect(s["shelter.S"].hash).not.toBe(s["shelter.N"].hash);
  });

  it("float noise and seabed order keep the value hash", () => {
    const a = comparisonValues(
      subject({ "shelter.N": 0.6, seabed: [{ type: "sand", share: 0.6 }, { type: "weed", share: 0.4 }] }),
      cfg,
    );
    const b = comparisonValues(
      subject({ "shelter.N": 0.6000001, seabed: [{ type: "weed", share: 0.4 }, { type: "sand", share: 0.6 }] }),
      cfg,
    );
    expect(b["shelter.N"].hash).toBe(a["shelter.N"].hash);
    expect(b.seabed.hash).toBe(a.seabed.hash);
    expect(a.seabed.value).toEqual(["sand", "weed"]);
  });

  it("crossing the protected threshold changes the hash", () => {
    const a = comparisonValues(subject({ "shelter.N": 0.55 }), cfg);
    const b = comparisonValues(subject({ "shelter.N": 0.45 }), cfg);
    expect(a["shelter.N"].value).toEqual({ protected: true });
    expect(b["shelter.N"].value).toEqual({ protected: false });
    expect(b["shelter.N"].display).toBe("0,45 (offen)");
    expect(b["shelter.N"].hash).not.toBe(a["shelter.N"].hash);
  });

  it("a 2 m position shift keeps the hash, 30 m changes it", () => {
    const base = comparisonValues(subject({}), cfg).position;
    const near = comparisonValues(subject({}, { position: { lon: 21.12342 + lonMetres(2), lat: 35.2 } }), cfg).position;
    const far = comparisonValues(subject({}, { position: { lon: 21.12342 + lonMetres(30), lat: 35.2 } }), cfg).position;
    expect(base.value).toEqual({ lon: 21.1234, lat: 35.2 });
    expect(near.hash).toBe(base.hash);
    expect(far.hash).not.toBe(base.hash);
  });

  it("the admin anchor position wins over the place position", () => {
    const v = comparisonValues(subject({}, { anchorPosition: { lon: 21.13, lat: 35.21 } }), cfg).position;
    expect(v.value).toEqual({ lon: 21.13, lat: 35.21 });
    expect(v.display).toBe("35,21000° N, 21,13000° O");
  });

  it("missing attributes give value null and display '–'", () => {
    const values = comparisonValues(subject({}), cfg);
    for (const a of COMPARISON_ATTRIBUTES.filter((k) => k !== "existence" && k !== "position")) {
      expect(values[a].value, a).toBeNull();
      expect(values[a].display, a).toBe("–");
    }
    // malformed values count as missing
    expect(comparisonValues(subject({ "shelter.N": "high", "services.water": "yes" }), cfg)["shelter.N"].value).toBeNull();
  });

  it("existence is the confirmed status", () => {
    expect(comparisonValues(subject({}), cfg).existence).toMatchObject({ value: true, display: "bestätigter Ort" });
    const rejected = comparisonValues(subject({}, { status: "rejected" }), cfg).existence;
    expect(rejected).toMatchObject({ value: false, display: "kein bestätigter Ort" });
  });

  it("depth takes the anchoring minimum before the minimum, rounded to the step", () => {
    const anchoring = comparisonValues(subject({ "depth.anchoring_min": 4.3, "depth.min": 2.1 }), cfg).depth;
    expect(anchoring).toMatchObject({ value: 4.5, display: "4,3 m" });
    expect(comparisonValues(subject({ "depth.min": 2.1 }), cfg).depth.value).toBe(2);
    expect(comparisonValues(subject({ "depth.anchoring_min": 4.4 }), cfg).depth.hash).toBe(anchoring.hash);
  });

  it("seabed keeps only types from the minimum share on", () => {
    const v = comparisonValues(subject({ seabed: [{ type: "sand", share: 0.8 }, { type: "rock", share: 0.2 }] }), cfg).seabed;
    expect(v.value).toEqual(["sand"]);
    expect(v.display).toBe("Sand 80 %, Fels 20 %");
  });

  it("buoys, water, supply and taverna compare presence only", () => {
    const values = comparisonValues(
      subject({
        "mooring.buoys": { present: true, count: 12, paid: true },
        "services.water": false,
        "highlight.supply": { present: true, names: ["Mini Market"] },
        "highlight.food": { present: false, names: [] },
      }),
      cfg,
    );
    expect(values["mooring.buoys"]).toMatchObject({ value: true, display: "ja (12, kostenpflichtig)" });
    expect(values["services.water"]).toMatchObject({ value: false, display: "nein" });
    expect(values["highlight.supply"]).toMatchObject({ value: true, display: "ja (Mini Market)" });
    expect(values["highlight.food"]).toMatchObject({ value: false, display: "nein" });
    const fewer = comparisonValues(subject({ "mooring.buoys": { present: true, count: 3, paid: null } }), cfg);
    expect(fewer["mooring.buoys"].hash).toBe(values["mooring.buoys"].hash);
  });
});
