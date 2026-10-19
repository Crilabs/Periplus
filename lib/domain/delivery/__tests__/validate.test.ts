import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { textShingles } from "@/lib/db/schema";
import { findArchiveCopies } from "@/lib/domain/documents/archive-copies";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import {
  breakPackage,
  HIGHLIGHT,
  INLAND_2NM,
  offsetSouth,
  OTHER_HL,
  OTHER_SP,
  PREVIOUS,
  SPOT_A,
  SPOT_X,
  validPackage,
} from "@/test/fixtures/delivery/package";
import { insertTestVersion } from "@/test/text";
import type { DeliveryPackage } from "../types";
import { buildWarnings, CHECK_NAMES, validatePackage, type CheckName, type ValidationDeps, type ValidationReport } from "../validate";

const config = loadConfig("config");
const cfg = config.delivery;

function validate(pkg: DeliveryPackage, deps: Partial<ValidationDeps> = {}): Promise<ValidationReport> {
  return validatePackage(pkg, {
    previous: PREVIOUS,
    findCopies: async () => 0,
    cfg,
    radiusNm: config.consolidation.importance.radiusNm,
    ...deps,
  });
}
const failed = (report: ValidationReport): CheckName[] => report.checks.filter((c) => !c.ok).map((c) => c.name);
const findings = (report: ValidationReport, name: CheckName) => report.checks.find((c) => c.name === name)!.findings;

type Patch = (p: DeliveryPackage) => void;
const spots = (p: DeliveryPackage) => p.files["spots.json"].spots;
const highlights = (p: DeliveryPackage) => p.files["highlights.json"].highlights;
/** A new object in the package is a `created` change (else `changes_complete` fails as well). */
const created = (p: DeliveryPackage, objectType: "spot" | "highlight", objectId: string) =>
  p.files["changes.json"]!.changes.push({ objectType, objectId, event: "created", fields: [], severity: "info", summary: { de: "Neu im Paket." }, profileVersion: 1 });

describe("validatePackage", () => {
  it("the valid fixture passes every check", async () => {
    const report = await validate(validPackage());
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    // every check is listed, in CHECK_NAMES order
    expect(report.checks.map((c) => c.name)).toEqual([...CHECK_NAMES]);
    expect(report.warnings).toEqual([]);
  });

  const cases: Array<[CheckName, Patch, Partial<ValidationDeps>?]> = [
    // six decimals: only zod knows the five-decimal rule (ruling M6-P23)
    ["json_schema", (p) => void (spots(p)[0]!.position.lat = 35.195001)],
    // a second marina under M's id (renaming M itself would also drop M from the package: changes_complete)
    ["ids", (p) => void spots(p).push({ ...spots(p)[1]!, position: { lat: 35.35, lon: 21.2 } })],
    ["references", (p) => void (spots(p)[0]!.highlightIds = ["hl_01J9X4KQ3P2N1M0Z9K8J7H6G5Z"])],
    ["spot_location", (p) => void (spots(p)[0]!.position = INLAND_2NM)],
    // marina, provenance computed
    ["shelter", (p) => void (spots(p)[1]!.shelter.sectors.S = 0.5)],
    ["limits", (p) => void (spots(p)[0]!.limits.maxDraft = 12)],
    // the marina: excluding A would leave the highlight without a counting spot
    ["exclude_reason", (p) => void (spots(p)[1]!.exclude = { excluded: true, reason: null, detail: null })],
    ["berth_months", (p) => void (spots(p)[1]!.berth = { status: "seasonFull", months: [], sourcesCount: 1, bookable: null })],
    ["low_confidence_note", (p) => void (spots(p)[0]!.score.confidence = 0.2)],
    // A is 7 nm away, importance 1 has a radius of 5 nm
    ["highlight_radius", (p) => void (highlights(p)[0]!.importance = 1)],
    [
      "spot_duplicates",
      (p) => {
        spots(p).push({ ...spots(p)[0]!, id: OTHER_SP, position: offsetSouth(spots(p)[0]!.position, 100), profileVersion: 1 });
        created(p, "spot", OTHER_SP);
      },
    ],
    // same normalized name (case and accents), 300 m apart
    [
      "highlight_duplicates",
      (p) => {
        highlights(p).push({ ...highlights(p)[0]!, id: OTHER_HL, name: "TAVERNA VATHI", position: offsetSouth(highlights(p)[0]!.position, 300) });
        created(p, "highlight", OTHER_HL);
      },
    ],
    ["verbatim_text", () => {}, { findCopies: async (text: string) => (text.startsWith("Tiefe Bucht") ? 2 : 0) }],
    ["foreign_content", (p) => void (spots(p)[0]!.externalRefs!.googlePlaceIds = { food: ["ChIJ..."] })],
    ["data_version", (p) => void (p.files["spots.json"].dataVersion = 3)],
    ["changes_complete", (p) => void p.files["changes.json"]!.changes.pop()],
  ];

  it("has one case per check", () => {
    expect(cases.map(([name]) => name).sort()).toEqual([...CHECK_NAMES].sort());
  });

  it.each(cases)("%s fails on a minimally broken package", async (name, patch, deps) => {
    const report = await validate(breakPackage(validPackage(), patch), deps);
    expect(failed(report)).toEqual([name]);
    expect(report.ok).toBe(false);
    for (const f of findings(report, name)) expect(f.message).toMatch(/\S/);
  });

  it("findings name the file, object and JSON pointer", async () => {
    const report = await validate(breakPackage(validPackage(), (p) => void (spots(p)[0]!.limits.maxDraft = 12)));
    expect(findings(report, "limits")).toEqual([
      { file: "spots.json", objectId: SPOT_A, path: "/spots/0/limits/maxDraft", message: "Maximaler Tiefgang 12 m außerhalb 0,5–10 m" },
    ]);
    const schema = await validate(breakPackage(validPackage(), (p) => void (spots(p)[0]!.position.lat = 35.195001)));
    expect(findings(schema, "json_schema")).toEqual([
      expect.objectContaining({ file: "spots.json", objectId: SPOT_A, path: "/spots/0/position/lat" }),
    ]);
  });

  it("a field outside the contract fails ajv and zod", async () => {
    const report = await validate(breakPackage(validPackage(), (p) => void ((spots(p)[0] as unknown as Record<string, unknown>).navilyRating = 4)));
    expect(failed(report)).toEqual(["json_schema"]);
    expect(findings(report, "json_schema").map((f) => f.message)).toEqual([
      expect.stringMatching(/^Schemaverstoß \(JSON-Schema\)/),
      expect.stringMatching(/^Schemaverstoß \(zod\)/),
    ]);
  });

  it("an excluded spot skips the shelter checks, also a harbour below the floor (ruling M6-B-R3)", async () => {
    const excludedHarbour = breakPackage(validPackage(), (p) => {
      spots(p)[1]!.exclude = { excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" };
      spots(p)[1]!.shelter.sectors = { N: 0, NE: 0, E: 0, SE: 0, S: 0, SW: 0, W: 0, NW: 0 };
    });
    expect(failed(await validate(excludedHarbour))).toEqual([]);
    const textSource = breakPackage(validPackage(), (p) => {
      spots(p)[1]!.shelter.sectors.S = 0.5;
      spots(p)[1]!.provenance["shelter"] = { source: "text", confidence: 0.7, observedAt: "2025-06-10" };
    });
    expect(failed(await validate(textSource))).toEqual([]);
  });

  it("highlight_radius counts no excluded or merged spot (ruling M6-P5)", async () => {
    const excluded = breakPackage(validPackage(), (p) => void (spots(p)[0]!.exclude = { excluded: true, reason: "military", detail: null }));
    expect(failed(await validate(excluded))).toEqual(["highlight_radius"]);
  });

  it("a merged spot is no duplicate of its target", async () => {
    const merged = breakPackage(validPackage(), (p) => {
      spots(p).push({ ...spots(p)[0]!, id: OTHER_SP, position: offsetSouth(spots(p)[0]!.position, 100), mergedInto: SPOT_A, highlightIds: [], profileVersion: 1 });
      created(p, "spot", OTHER_SP);
    });
    expect(failed(await validate(merged))).toEqual([]);
  });

  it("references: a removed object needs not be in the package, any other change entry does", async () => {
    const report = await validate(
      breakPackage(validPackage(), (p) => void (p.files["changes.json"]!.changes.find((c) => c.objectId === SPOT_X)!.event = "updated")),
    );
    expect(failed(report)).toEqual(["references", "changes_complete"]);
  });

  it("changes_complete: an unchanged object listed, a wrong version and a missing changes.json fail", async () => {
    const unchanged = breakPackage(validPackage(), (p) =>
      void p.files["changes.json"]!.changes.push({
        objectType: "highlight",
        objectId: HIGHLIGHT,
        event: "updated",
        fields: ["name"],
        severity: "info",
        summary: { de: "Geändert: Name." },
        profileVersion: 1,
      }),
    );
    expect(findings(await validate(unchanged), "changes_complete")).toEqual([expect.objectContaining({ objectId: HIGHLIGHT, message: "Eintrag ohne gestiegene Version" })]);
    const version = breakPackage(validPackage(), (p) => void (p.files["changes.json"]!.changes[0]!.profileVersion = 3));
    expect(failed(await validate(version))).toEqual(["changes_complete"]);
    const missing = breakPackage(validPackage(), (p) => void delete p.files["changes.json"]);
    expect(findings(await validate(missing), "changes_complete")).toEqual([expect.objectContaining({ message: "changes.json fehlt, obwohl es eine vorige Lieferung gibt" })]);
  });

  it("the first delivery: data version ≥ 1 without a predecessor and no changes.json", async () => {
    const first = breakPackage(validPackage(), (p) => {
      delete p.files["changes.json"];
      p.manifest.dataVersion = 1;
      p.manifest.previousDataVersion = null;
      for (const f of [p.files["spots.json"], p.files["highlights.json"], p.files["regions.json"], p.files["weather-points.json"]]) f.dataVersion = 1;
    });
    expect(failed(await validate(first, { previous: null }))).toEqual([]);
    expect(failed(await validate(validPackage(), { previous: null }))).toEqual(["data_version", "changes_complete"]);
  });

  it("a navily source url is foreign content", async () => {
    const report = await validate(
      breakPackage(validPackage(), (p) => void spots(p)[0]!.sources!.push({ url: "https://www.navily.com/port/vathi", kind: "other", observedAt: "2025-01-01" })),
    );
    expect(failed(report)).toEqual(["foreign_content"]);
    expect(findings(report, "foreign_content")).toEqual([
      { file: "spots.json", objectId: SPOT_A, path: "/spots/0/sources/2/url", message: "Quelle von einer gesperrten Domain" },
    ]);
  });

  it("a link in a text field is foreign content", async () => {
    const report = await validate(breakPackage(validPackage(), (p) => void (spots(p)[0]!.summary = { de: "Mehr unter www.navily.com nachlesen." })));
    expect(findings(report, "foreign_content")).toEqual([expect.objectContaining({ path: "/spots/0/summary/de", message: "Text enthält einen Link" })]);
  });

  /** `n` words no other text has, each with an accent: a uuid salt in letters plus a running suffix. */
  function saltedWords(n: number): string[] {
    const salt = newId().replace(/-/g, "").replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!);
    return Array.from({ length: n }, (_, i) => `${salt}${"abcdefghijklmnopqrstuvwxyz"[i % 26]}é`);
  }
  async function archived(tx: Db, text: string): Promise<void> {
    const v = await insertTestVersion(tx, [text]);
    await tx.insert(textShingles).values(shingleHashes(text, 15).map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
  }
  const fromArchive = (tx: Db) => async (text: string) => (await findArchiveCopies(tx, text)).hits;

  it("a summary copying 16 words of a chunk with different accents is a violation", async () => {
    await withRollback(async (tx) => {
      const words = saltedWords(30);
      await archived(tx, words.join(" "));
      const copied = words.slice(4, 20).join(" ").toUpperCase().normalize("NFD").replace(/\p{M}/gu, "");
      const report = await validate(
        breakPackage(validPackage(), (p) => void (spots(p)[0]!.summary = { de: `Die Bucht: ${copied}.` })),
        { findCopies: fromArchive(tx) },
      );
      expect(failed(report)).toEqual(["verbatim_text"]);
      expect(findings(report, "verbatim_text")).toEqual([
        expect.objectContaining({ file: "spots.json", objectId: SPOT_A, path: "/spots/0/summary/de" }),
      ]);
    });
  });

  it("a 15-word own sentence is no violation", async () => {
    await withRollback(async (tx) => {
      const words = saltedWords(30);
      await archived(tx, words.join(" "));
      // 14 words of the chunk and one of our own: no 15-word run of the source
      const own = `${words.slice(0, 14).join(" ")} eigen`;
      const sentence = "Die Bucht bietet guten Schutz vor Meltemi und hat abends meist noch viele freie Plätze.";
      expect(sentence.split(" ")).toHaveLength(15);
      const report = await validate(
        breakPackage(validPackage(), (p) => {
          spots(p)[0]!.summary = { de: sentence };
          highlights(p)[0]!.summary = { de: own };
        }),
        { findCopies: fromArchive(tx) },
      );
      expect(failed(report)).toEqual([]);
    });
  });

  it("a check the package is too broken for is a finding; a failing copy check is rethrown", async () => {
    const broken = breakPackage(validPackage(), (p) => void ((p.files["highlights.json"] as unknown as Record<string, unknown>).highlights = null));
    const report = await validate(broken);
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.name)).toEqual([...CHECK_NAMES]);
    expect(findings(report, "references")[0]!.message).toMatch(/^Prüfung nicht ausführbar/);
    const down = new Error("connection refused");
    await expect(validate(validPackage(), { findCopies: async () => Promise.reject(down) })).rejects.toBe(down);
  });

  it("passes the build warnings through and warns about a missing summary (ruling M6-P9)", async () => {
    const warnings = buildWarnings({ omittedSpots: [{ id: OTHER_SP, reason: "no_profile" }] });
    const report = await validate(breakPackage(validPackage(), (p) => void delete spots(p)[1]!.summary), { warnings });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([
      { file: "spots.json", objectId: OTHER_SP, path: null, message: "Nicht geliefert: kein Profil" },
      { file: "spots.json", objectId: spots(validPackage())[1]!.id, path: "/spots/1/summary", message: "Zusammenfassung fehlt" },
    ]);
  });
});

describe("buildWarnings", () => {
  it("names every warning and every object left out, in German (rulings M6-P31, M6-B-R1)", () => {
    const geoObjectId = "01a15602-0000-7000-8000-000000000001";
    const out = buildWarnings({
      spots: [
        { id: SPOT_A, warnings: [{ code: "missing_provenance", field: "depth" }, { code: "missing_provenance", field: "shelter" }] },
        { id: OTHER_SP, warnings: [{ code: "fallback_name" }] },
      ],
      omittedSpots: [
        { id: SPOT_X, reason: "no_name" },
        { id: SPOT_X, reason: "shelter_incomplete" },
      ],
      droppedHighlights: [
        { id: OTHER_HL, reason: "duplicate", into: HIGHLIGHT },
        { id: OTHER_HL, reason: "not_existing" },
      ],
      droppedRegions: [{ id: "rg_01J9ZD00000000000000000002", reason: "no_name" }],
      droppedWeatherPoints: [{ geoObjectId, kind: "cape", reason: "no_water" }],
    });
    expect(out.map((f) => [f.file, f.objectId, f.message])).toEqual([
      ["spots.json", SPOT_A, "Tiefe ohne Herkunft, nicht geliefert"],
      ["spots.json", SPOT_A, "Schutzwerte ohne Herkunft geliefert (ausgeschlossener Spot)"],
      ["spots.json", OTHER_SP, "Ausgeschlossener Spot ohne gültigen Namen, mit Ersatznamen geliefert"],
      ["spots.json", SPOT_X, "Nicht geliefert: kein gültiger Name"],
      ["spots.json", SPOT_X, "Nicht geliefert: Schutzwerte unvollständig oder ohne Herkunft"],
      ["highlights.json", OTHER_HL, `Nicht geliefert: Dublette von ${HIGHLIGHT}`],
      ["highlights.json", OTHER_HL, "Nicht geliefert: existiert laut Profil nicht mehr"],
      ["regions.json", "rg_01J9ZD00000000000000000002", "Nicht geliefert: kein gültiger Name"],
      ["weather-points.json", expect.stringMatching(/^wp_/), "Nicht geliefert: kein offenes Wasser in der Region"],
    ]);
  });
});
