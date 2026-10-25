import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { textShingles } from "@/lib/db/schema";
import { imageAttributionTexts } from "@/lib/domain/images/delivery-gate";
import { findArchiveCopies } from "@/lib/domain/documents/archive-copies";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import {
  breakPackage,
  FACT_LANDSIDE,
  INLAND_2NM,
  offsetSouth,
  OTHER_SP,
  PREVIOUS,
  SPOT_A,
  SPOT_M,
  SUBDIVISION_ID,
  TAVERNA,
  validPackage,
} from "@/test/fixtures/delivery/package-v4";
import { insertTestVersion } from "@/test/text";
import type { DeliveryPackage } from "../types";
import { buildWarnings, CHECK_NAMES, dropCopiedTexts, failedChecksSummary, spotsInMilitaryAreas, validatePackage, type CheckName, type ValidationDeps, type ValidationReport } from "../validate";

const config = loadConfig("config");
const cfg = config.delivery;
const imagesCfg = config.images;
const OTHER_SD = "sd_01J9ZD00000000000000000009";

/** The manifest's subdivision scope (the fixture is one). */
function subdivisionScope(p: DeliveryPackage): Extract<DeliveryPackage["manifest"]["scope"], { type: "subdivision" }> {
  if (p.manifest.scope.type !== "subdivision") throw new Error("fixture is a subdivision package");
  return p.manifest.scope;
}

function validate(pkg: DeliveryPackage, deps: Partial<ValidationDeps> = {}): Promise<ValidationReport> {
  return validatePackage(pkg, {
    previous: PREVIOUS,
    findCopies: async () => 0,
    cfg,
    ...deps,
  });
}
const failed = (report: ValidationReport): CheckName[] => report.checks.filter((c) => !c.ok).map((c) => c.name);
const findings = (report: ValidationReport, name: CheckName) => report.checks.find((c) => c.name === name)!.findings;

type Patch = (p: DeliveryPackage) => void;
const spots = (p: DeliveryPackage) => p.files["spots.json"].spots;
/** The landside fact of A and its text. */
const landsideFact = (p: DeliveryPackage) => spots(p)[0]!.facts.find((f) => f.id === FACT_LANDSIDE)!;
describe("validatePackage", () => {
  it("the valid fixture passes every check", async () => {
    const report = await validate(validPackage());
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    // every check is listed, in CHECK_NAMES order
    expect(report.checks.map((c) => c.name)).toEqual([...CHECK_NAMES]);
    expect(report.warnings).toEqual([]);
  });

  it("a package with a commercial port (berthable false, no contact) passes every check (spec 17)", async () => {
    const pkg = validPackage();
    spots(pkg)[1]!.kind = "port";
    spots(pkg)[1]!.berthable = false;
    spots(pkg)[1]!.contact = null;
    expect(failed(await validate(pkg))).toEqual([]);
  });

  it("a landside fact pointing at an entry that is not in the nearby of the same spot fails references (review focus)", async () => {
    // the taverna is in A's nearby, not in M's: the same id in a fact of M is a dangling reference
    const pkg = breakPackage(validPackage(), (p) => void spots(p)[1]!.facts.push({ ...landsideFact(p) }));
    const report = await validate(pkg);
    expect(failed(report)).toEqual(["references"]);
    expect(findings(report, "references")).toEqual([
      { file: "spots.json", objectId: SPOT_M, path: "/spots/1/facts/0/subject/id", message: `Fakt verweist auf ${TAVERNA}, das nicht in nearby desselben Spots steht` },
    ]);
    // a fact that names its object only by name needs no nearby entry
    const named = breakPackage(validPackage(), (p) => void (spots(p)[1]!.facts = [{ ...landsideFact(p), subject: { kind: "landside", id: null, name: "Taverna Vathi" } }]));
    expect(failed(await validate(named))).toEqual([]);
  });

  const cases: Array<[CheckName, Patch, Partial<ValidationDeps>?]> = [
    // six decimals: only zod knows the five-decimal rule (ruling M6-P23)
    ["json_schema", (p) => void (spots(p)[0]!.position.lat = 35.195001)],
    // a second marina under M's id
    ["ids", (p) => void spots(p).push({ ...spots(p)[1]!, position: { lat: 35.35, lon: 21.2 } })],
    ["references", (p) => void (spots(p)[0]!.regionId = "rg_01J9X4KZ0A1B2C3D4E5F6G7H8Z")],
    ["spot_location", (p) => void (spots(p)[0]!.position = INLAND_2NM)],
    // marina, provenance computed
    ["shelter", (p) => void (spots(p)[1]!.shelter.sectors.S = 0.5)],
    ["limits", (p) => void (spots(p)[0]!.limits.maxDraft = 12)],
    ["exclude_reason", (p) => void (spots(p)[1]!.exclude = { excluded: true, reason: null, detail: null })],
    ["berth_months", (p) => void (spots(p)[1]!.berth = { status: "seasonFull", months: [], sourcesCount: 1, bookable: null })],
    [
      "spot_duplicates",
      (p) => {
        spots(p).push({ ...spots(p)[0]!, id: OTHER_SP, position: offsetSouth(spots(p)[0]!.position, 100) });
      },
    ],
    ["verbatim_text", () => {}, { findCopies: async (text: string) => (text.startsWith("Die Taverne") ? 16 : 0) }],
    [
      "image_attribution",
      (p) =>
        void (spots(p)[0]!.images = [
          {
            kind: "ai_illustration",
            slot: "title",
            file: `images/${SPOT_A}-title.jpg`,
            width: 1536,
            height: 1024,
            alt: { de: "KI-Illustration: Bucht" },
            light: "midday",
            observedAt: null,
            license: "periplus",
            attribution: `${imagesCfg.sources.sentinel2.attribution} · Illustration: Periplus`,
            camera: null,
          },
        ]),
      { imageAttribution: imageAttributionTexts(imagesCfg) },
    ],
    ["foreign_content", (p) => void (landsideFact(p).text = "Die Karte steht auf https://example.org/vathi.")],
    ["data_version", (p) => void (p.files["spots.json"].scope = { type: "subdivision", id: SUBDIVISION_ID, dataVersion: 3 })],
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

  it("a harbour below the floor passes with review-backed shelter, not with computed (ruling M6-D-R2)", async () => {
    const withSource = (source: "review" | "computed") =>
      breakPackage(validPackage(), (p) => {
        spots(p)[1]!.shelter.sectors.S = 0.5;
        spots(p)[1]!.provenance["shelter"] = { source, confidence: 0.9, observedAt: "2026-10-01" };
      });
    expect(failed(await validate(withSource("review")))).toEqual([]);
    expect(failed(await validate(withSource("computed")))).toEqual(["shelter"]);
    expect(cfg.validation.harbourShelterSources).toEqual(["text", "observed", "review"]);
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

  it("an excluded spot is no duplicate of a usable one of the same kind (validation review M-8)", async () => {
    const excluded = breakPackage(validPackage(), (p) => {
      spots(p).push({
        ...spots(p)[0]!,
        id: OTHER_SP,
        position: offsetSouth(spots(p)[0]!.position, 100),
        exclude: { excluded: true, reason: "anchoringProhibited", detail: null },
      });
    });
    expect(failed(await validate(excluded))).toEqual([]);
  });

  it("a merged spot is no duplicate of its target", async () => {
    const merged = breakPackage(validPackage(), (p) => {
      spots(p).push({ ...spots(p)[0]!, id: OTHER_SP, position: offsetSouth(spots(p)[0]!.position, 100), mergedInto: SPOT_A });
    });
    expect(failed(await validate(merged))).toEqual([]);
  });

  it("data_version: the previous version plus 1, not just greater (validation review M-4)", async () => {
    const skip = breakPackage(validPackage(), (p) => {
      p.manifest.scope = { ...subdivisionScope(p), dataVersion: 3 };
      for (const f of [p.files["spots.json"], p.files["regions.json"], p.files["weather-points.json"]]) {
        f.scope = { type: "subdivision", id: SUBDIVISION_ID, dataVersion: 3 };
      }
    });
    expect(findings(await validate(skip), "data_version")).toEqual([expect.objectContaining({ path: "/scope/dataVersion", message: "Datenversion 3 statt 2 (die vorige plus 1)" })]);
  });

  it("data_version: a file head naming another subdivision than the manifest's scope is a finding", async () => {
    const report = await validate(
      breakPackage(validPackage(), (p) => void (p.files["spots.json"].scope = { type: "subdivision", id: OTHER_SD, dataVersion: 2 })),
    );
    expect(findings(report, "data_version")).toEqual([
      expect.objectContaining({ file: "spots.json", path: "/scope/id", message: `Landesteil ${OTHER_SD} statt ${SUBDIVISION_ID} wie im Manifest` }),
    ]);
    const type = await validate(breakPackage(validPackage(), (p) => void (p.files["spots.json"].scope = { type: "radius", key: "0123456789abcdef" })));
    expect(findings(type, "data_version")).toEqual([expect.objectContaining({ file: "spots.json", path: "/scope/type" })]);
  });

  it("the first delivery: data version 1 without a predecessor", async () => {
    const first = breakPackage(validPackage(), (p) => {
      p.manifest.scope = { ...subdivisionScope(p), dataVersion: 1, previousDataVersion: null };
      p.manifest.coverage = p.manifest.coverage.map((c) => ({ ...c, status: "delivered" as const, dataVersion: 1 }));
      for (const f of [p.files["spots.json"], p.files["regions.json"], p.files["weather-points.json"]]) {
        f.scope = { type: "subdivision", id: SUBDIVISION_ID, dataVersion: 1 };
      }
    });
    expect(failed(await validate(first, { previous: null }))).toEqual([]);
    expect(failed(await validate(validPackage(), { previous: null }))).toEqual(["data_version"]);
  });

  const anImage = {
    kind: "photo" as const,
    slot: "title",
    file: `images/${SPOT_A}-title.jpg`,
    width: 1536,
    height: 1024,
    alt: { de: "Bucht" },
    light: "midday" as const,
    observedAt: null,
    license: "x",
    attribution: "x",
    camera: null,
  };

  /** Foreign content in each text the package carries: fact statements, landing descriptions and names. */
  const textFields: Array<[string, (p: DeliveryPackage, text: string) => void, string]> = [
    ["a fact statement", (p, t) => void (landsideFact(p).text = t), "/spots/0/facts/1/text"],
    ["a landing description", (p, t) => void (spots(p)[0]!.landingPoints[1] = { kind: "text", description: t }), "/spots/0/landingPoints/1/description"],
    ["a spot name", (p, t) => void (spots(p)[0]!.name = t), "/spots/0/name"],
    ["a nearby name", (p, t) => void (spots(p)[0]!.nearby[0]!.name = t), "/spots/0/nearby/0/name"],
    ["a region name", (p, t) => void (p.files["regions.json"].regions[0]!.name = t), "/regions/0/name"],
    ["a hazard text", (p, t) => void (spots(p)[0]!.hazards = [{ kind: "rock", text: t }]), "/spots/0/hazards/0/text"],
    ["a season note", (p, t) => void (spots(p)[0]!.seasonNote = [{ months: [7], text: t }]), "/spots/0/seasonNote/0/text"],
    ["an exclude detail", (p, t) => void (spots(p)[1]!.exclude = { excluded: true, reason: "military", detail: t }), "/spots/1/exclude/detail"],
    ["an image alt", (p, t) => void (spots(p)[0]!.images = [{ ...anImage, alt: { de: t } }]), "/spots/0/images/0/alt/de"],
    ["a region character", (p, t) => void (p.files["regions.json"].regions[0]!.character = { de: t }), "/regions/0/character/de"],
    ["a weather point name", (p, t) => void (p.files["weather-points.json"].points[0]!.name = t), "/points/0/name"],
    ["a contact phone", (p, t) => void (spots(p)[1]!.contact = { vhf: null, phone: t, url: null }), "/spots/1/contact/phone"],
    ["a contact vhf", (p, t) => void (spots(p)[1]!.contact = { vhf: t, phone: null, url: null }), "/spots/1/contact/vhf"],
  ];

  it.each(textFields)("%s with a URL is foreign content", async (_label, set, path) => {
    const report = await validate(breakPackage(validPackage(), (p) => set(p, "Mehr unter www.example.org/bucht nachlesen.")));
    expect(findings(report, "foreign_content")).toEqual([expect.objectContaining({ path, message: "Text enthält einen Link" })]);
  });

  it.each(textFields)("%s with a bare domain name is foreign content, not only a forbidden one", async (_label, set, path) => {
    for (const text of ["Siehe sailing-guide.gr für Details", "Tipp von bucht-blog.com", "Kontakt: skipper@marina-info.eu"]) {
      const report = await validate(breakPackage(validPackage(), (p) => set(p, text)));
      expect(findings(report, "foreign_content"), text).toEqual([expect.objectContaining({ path, message: expect.stringMatching(/^Text enthält einen Domainnamen \(.+\)$/) })]);
    }
  });

  it("a bare forbidden domain in a text is foreign content (validation review M-1)", async () => {
    const report = await validate(breakPackage(validPackage(), (p) => void (landsideFact(p).text = "Laut navily.com/port/vathi gut.")));
    expect(findings(report, "foreign_content")).toEqual([expect.objectContaining({ path: "/spots/0/facts/1/text", message: "Text nennt eine gesperrte Domain" })]);
    const dot = await validate(breakPackage(validPackage(), (p) => void (landsideFact(p).text = "Laut Navily.COM. gut.")));
    expect(findings(dot, "foreign_content")).toEqual([expect.objectContaining({ message: "Text nennt eine gesperrte Domain" })]);
  });

  it("the finding names the matched domain; a missing space after a full stop is no domain", async () => {
    const hit = await validate(breakPackage(validPackage(), (p) => void (landsideFact(p).text = "Mehr dazu: sailing-guide.gr")));
    expect(findings(hit, "foreign_content")[0]!.message).toBe("Text enthält einen Domainnamen (sailing-guide.gr)");
    const see = await validate(breakPackage(validPackage(), (p) => void (landsideFact(p).text = "see navily.com")));
    expect(failed(see)).toEqual(["foreign_content"]);
    const typo = await validate(breakPackage(validPackage(), (p) => void (landsideFact(p).text = "Der Anker hält gut, die Bucht ist geschützt.Es ist ruhig. Hafen.No problem.")));
    expect(failed(typo)).toEqual([]);
  });

  it("contact.url is allowed unless it is of a forbidden domain; the domain TLDs are configured", async () => {
    const withUrl = (url: string) => breakPackage(validPackage(), (p) => void (spots(p)[1]!.contact = { vhf: "71", phone: "+30 22980 12345", url }));
    expect(failed(await validate(withUrl("https://www.marina-nisida.gr/")))).toEqual([]);
    const bad = await validate(withUrl("https://www.navily.com/port/vathi"));
    expect(findings(bad, "foreign_content")).toEqual([expect.objectContaining({ objectId: SPOT_M, path: "/spots/1/contact/url", message: "Kontaktadresse von einer gesperrten Domain" })]);
    expect(cfg.validation.domainTlds).toEqual(expect.arrayContaining(["com", "gr", "de"]));
  });

  it("names and sentences that merely contain dots are no foreign content", async () => {
    const report = await validate(
      breakPackage(validPackage(), (p) => {
        spots(p)[0]!.name = "Ag.Nikolaos Bay";
        landsideFact(p).text = "Die Mole ist ca. 3.5 m tief, Wassertiefe 2.4 m, z. B. bei Südwind.";
      }),
    );
    expect(failed(report)).toEqual([]);
  });

  it("a Google place id that is no plain id fails the contract schema too (validation review M-7)", async () => {
    const report = await validate(breakPackage(validPackage(), (p) => void (spots(p)[0]!.externalRefs!.googlePlaceIds = { food: ["ChIJ..."] })));
    expect(failed(report)).toEqual(["json_schema", "foreign_content"]);
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
  const fromArchive = (tx: Db) => async (text: string) => (await findArchiveCopies(tx, text)).longestRun;

  it("a fact statement copying 16 words of an archived document, with different accents, is a violation (review focus)", async () => {
    await withRollback(async (tx) => {
      const words = saltedWords(30);
      await archived(tx, words.join(" "));
      const copied = words.slice(4, 20).join(" ").toUpperCase().normalize("NFD").replace(/\p{M}/gu, "");
      const report = await validate(
        breakPackage(validPackage(), (p) => void (landsideFact(p).text = `Die Bucht: ${copied}.`)),
        { findCopies: fromArchive(tx) },
      );
      expect(failed(report)).toEqual(["verbatim_text"]);
      expect(findings(report, "verbatim_text")).toEqual([
        expect.objectContaining({ file: "spots.json", objectId: SPOT_A, path: "/spots/0/facts/1/text" }),
      ]);
    });
  });

  it("a landing description copying 16 words of an archived document is a violation", async () => {
    await withRollback(async (tx) => {
      const words = saltedWords(30);
      await archived(tx, words.join(" "));
      const report = await validate(
        breakPackage(validPackage(), (p) => void (spots(p)[0]!.landingPoints[1] = { kind: "text", description: words.slice(2, 18).join(" ") })),
        { findCopies: fromArchive(tx) },
      );
      expect(failed(report)).toEqual(["verbatim_text"]);
      expect(findings(report, "verbatim_text")).toEqual([expect.objectContaining({ path: "/spots/0/landingPoints/1/description" })]);
    });
  });

  it("dropCopiedTexts removes a copied or foreign fact and landing description with a warning, nothing else (F3)", async () => {
    const pkg = validPackage();
    const a = spots(pkg)[0]!;
    a.landingPoints = [...a.landingPoints, { kind: "text", description: "COPIED landing text" }, { kind: "text", description: "Visit www.example.org for the landing" }];
    a.facts = a.facts.map((f) => (f.id === FACT_LANDSIDE ? { ...f, text: "COPIED fact text" } : f));
    const before = { facts: a.facts.length, landing: a.landingPoints.length, name: a.name };
    const draft = { body: a, warnings: [] as Array<{ code: string }> };
    await dropCopiedTexts([draft as never], { findCopies: async (text) => (text.startsWith("COPIED") ? 16 : 0), cfg });
    expect(draft.body.facts.map((f) => f.id)).not.toContain(FACT_LANDSIDE);
    expect(draft.body.facts).toHaveLength(before.facts - 1);
    expect(draft.body.landingPoints).toHaveLength(before.landing - 2);
    expect(draft.body.name).toBe(before.name);
    expect(draft.warnings.map((w) => w.code).sort()).toEqual(["fact_dropped", "landing_description_dropped", "landing_description_dropped"]);
    // an 15-word run stays (the limit is more than 15 words)
    const kept = { body: validPackage().files["spots.json"].spots[0]!, warnings: [] as never[] };
    await dropCopiedTexts([kept], { findCopies: async () => 15, cfg });
    expect(kept.warnings).toEqual([]);
  });

  it("an exact 15-word copy is no violation: Teil B forbids more than 15 words (validation review M-3)", async () => {
    await withRollback(async (tx) => {
      const words = saltedWords(30);
      await archived(tx, words.join(" "));
      const fifteen = (p: DeliveryPackage) => void (landsideFact(p).text = `Die Bucht: ${words.slice(3, 18).join(" ")}.`);
      expect(failed(await validate(breakPackage(validPackage(), fifteen), { findCopies: fromArchive(tx) }))).toEqual([]);
    });
  });

  it("copy checks run with bounded concurrency; a synchronous throw is rethrown, not a finding (validation review M-6)", async () => {
    let running = 0;
    let peak = 0;
    const findCopies = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running -= 1;
      return 0;
    };
    const many = breakPackage(validPackage(), (p) => {
      for (let i = 0; i < 12; i++) spots(p)[0]!.seasonNote = [...(spots(p)[0]!.seasonNote ?? []), { months: [7], text: `Hinweis ${i}` }];
    });
    expect(failed(await validate(many, { findCopies }))).toEqual([]);
    expect(peak).toBe(cfg.validation.copyCheckConcurrency);
    const down = new Error("pool exhausted");
    const throwing = (() => {
      throw down;
    }) as unknown as ValidationDeps["findCopies"];
    await expect(validate(validPackage(), { findCopies: throwing })).rejects.toBe(down);
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
          landsideFact(p).text = sentence;
          spots(p)[0]!.facts[0]!.text = own;
        }),
        { findCopies: fromArchive(tx) },
      );
      expect(failed(report)).toEqual([]);
    });
  });

  it("a check the package is too broken for is a finding; a failing copy check is rethrown", async () => {
    const broken = breakPackage(validPackage(), (p) => void ((p.files["spots.json"].spots[0] as unknown as Record<string, unknown>).facts = null));
    const report = await validate(broken);
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.name)).toEqual([...CHECK_NAMES]);
    expect(findings(report, "references")[0]!.message).toMatch(/^Prüfung nicht ausführbar/);
    const down = new Error("connection refused");
    await expect(validate(validPackage(), { findCopies: async () => Promise.reject(down) })).rejects.toBe(down);
  });

  it("passes the build warnings through", async () => {
    const warnings = buildWarnings({ omittedSpots: [{ id: OTHER_SP, reason: "no_state" }] });
    const report = await validate(validPackage(), { warnings });
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([{ file: "spots.json", objectId: OTHER_SP, path: null, message: "Nicht geliefert: kein Stand" }]);
  });
});

describe("buildWarnings", () => {
  it("names every warning and every object left out, in German (rulings M6-P31, M6-B-R1)", () => {
    const geoObjectId = "01a15602-0000-7000-8000-000000000001";
    const out = buildWarnings({
      spots: [
        { id: SPOT_A, warnings: [{ code: "nearby_without_id", geoObjectId: "g1" }, { code: "fact_without_subject", factId: "f1" }, { code: "safety_fact_without_subject", factId: "f2" }] },
        { id: OTHER_SP, warnings: [{ code: "fallback_name" }] },
      ],
      omittedSpots: [
        { id: OTHER_SP, reason: "no_name" },
        { id: OTHER_SP, reason: "incomplete_core" },
      ],
      droppedRegions: [{ id: "rg_01J9ZD00000000000000000002", reason: "no_name" }],
      droppedWeatherPoints: [{ geoObjectId, kind: "cape", reason: "no_water" }],
    });
    expect(out.map((f) => [f.file, f.objectId, f.message])).toEqual([
      ["spots.json", SPOT_A, "Ding an Land ohne öffentliche ID, nicht geliefert"],
      ["spots.json", SPOT_A, "Landfakt ohne Bezugsnamen, nicht geliefert"],
      ["spots.json", SPOT_A, "Sicherheitsfakt ohne Bezugsnamen, nicht geliefert: Sicherheitshinweis geht verloren"],
      ["spots.json", OTHER_SP, "Ausgeschlossener Spot ohne gültigen Namen, mit Ersatznamen geliefert"],
      ["spots.json", OTHER_SP, "Nicht geliefert: kein gültiger Name"],
      ["spots.json", OTHER_SP, "Nicht geliefert: Schutz oder Ankerposition fehlt im Stand"],
      ["regions.json", "rg_01J9ZD00000000000000000002", "Nicht geliefert: kein gültiger Name"],
      ["weather-points.json", expect.stringMatching(/^wp_/), "Nicht geliefert: kein offenes Wasser in der Region"],
    ]);
  });

  it("text-only safety values and spots in a military area of the package become warnings (final review I-3, M-7)", () => {
    const out = buildWarnings({
      undeliveredSafety: [{ file: "regions.json", id: "rg_01J9ZD00000000000000000002", message: "Sperrgebiet laut Text nicht geliefert: Schießgebiet" }],
      militaryAreaSpots: [SPOT_A],
    });
    expect(out.map((f) => [f.file, f.objectId, f.message])).toEqual([
      ["regions.json", "rg_01J9ZD00000000000000000002", "Sperrgebiet laut Text nicht geliefert: Schießgebiet"],
      ["spots.json", SPOT_A, "Liegt in einem militärischen Sperrgebiet des Pakets (coast.geojson), ist aber nicht ausgeschlossen: Profil oder Status prüfen"],
    ]);
  });
});

describe("spotsInMilitaryAreas (final review M-7)", () => {
  const around = (lon: number, lat: number, d = 0.01) => ({
    type: "Polygon" as const,
    coordinates: <Array<Array<[number, number]>>> [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]],
  });
  const restricted = (reason: "military" | "protectedArea", g: ReturnType<typeof around>) => ({
    type: "Feature" as const,
    geometry: g,
    properties: { kind: "restrictedArea" as const, reason, source: "OpenStreetMap, ODbL" },
  });

  it("names a non-excluded spot inside a military area, not an excluded one and not one in another kind of area", () => {
    const pkg = validPackage();
    const [a, marina] = pkg.files["spots.json"].spots;
    const coast = pkg.files["coast.geojson"];
    expect(spotsInMilitaryAreas([a!, marina!], coast)).toEqual([]);
    coast.features.push(restricted("military", around(a!.position.lon, a!.position.lat)), restricted("protectedArea", around(marina!.position.lon, marina!.position.lat)));
    expect(spotsInMilitaryAreas([a!, marina!], coast)).toEqual([SPOT_A]);
    const excluded = { ...a!, exclude: { ...a!.exclude, excluded: true } };
    expect(spotsInMilitaryAreas([excluded, marina!], coast)).toEqual([]);
  });
});

describe("failedChecksSummary (bundle H review)", () => {
  it("names each failed check with its first findings, or none", async () => {
    expect(failedChecksSummary(await validate(validPackage()))).toBe("none");
    const report = await validate(breakPackage(validPackage(), (p) => void (spots(p)[0]!.limits.maxDraft = 12)));
    expect(failedChecksSummary(report)).toMatch(new RegExp(`^limits \\(spots\\.json ${SPOT_A}: .+\\)$`));
    const many = { ok: false, warnings: [], checks: [{ name: "shelter" as const, ok: false, findings: [1, 2, 3, 4].map((n) => ({ file: "spots.json" as const, objectId: null, path: null, message: `m${n}` })) }] };
    expect(failedChecksSummary(many, 2)).toBe("shelter (spots.json: m1; spots.json: m2; … 2 more)");
  });
});
