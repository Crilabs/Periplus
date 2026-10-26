import { CONTRACT_SCHEMAS, type CoastCollection, type ContractFile, type FileScope, type Spot, type SpotBody } from "@/contract";
import { GOOGLE_PLACE_ID_PATTERN, OSM_ID_PATTERN, WIKIDATA_ID_PATTERN } from "@/contract/v2";
import type { DeliveryConfig } from "@/lib/config/schemas";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { isPublicId, type PublicIdPrefix } from "@/lib/domain/ids";
import { isForbiddenUrl, mentionsForbiddenDomain } from "@/lib/domain/sources/forbidden-domains";
import { distanceNm, distanceToLinesNm, pointInPolygon } from "./geo";
import type { SpotWarning } from "./map-spot";
import { checkJsonSchema } from "./schema-check";
import type { DeliveryPackage, LonLat } from "./types";
import { weatherPointId, type DroppedWeatherPoint } from "./weather-points";

/*
 * Package validation (spec 08, Teil B "Validierung", contract 4.0): one named check per rule, each with its findings (file, object,
 * JSON pointer, German message, ruling M6-P31); a violation of any check blocks the package. Warnings (objects left
 * out while building, values dropped) never block. Pure apart from the injected copy check.
 */

export const CHECK_NAMES = [
  "json_schema",
  "ids",
  "references",
  "spot_location",
  "shelter",
  "limits",
  "exclude_reason",
  "berth_months",
  "spot_duplicates",
  "verbatim_text",
  "image_attribution",
  "foreign_content",
  "data_version",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type Finding = { file: ContractFile; objectId: string | null; path: string | null; message: string };
export type ValidationReport = { ok: boolean; checks: Array<{ name: CheckName; ok: boolean; findings: Finding[] }>; warnings: Finding[] };

export type ValidationDeps = {
  /** The subdivision's previous valid package: its data version. */
  previous: { dataVersion: number } | null;
  /** The longest run of words of the text copied from the archive (`findArchiveCopies(db, text).longestRun`). */
  findCopies: (text: string) => Promise<number>;
  cfg: DeliveryConfig;
  /**
   * The attribution texts of the aerial and the terrain sources (`imageAttributionTexts`): an AI illustration's
   * attribution must contain one of each. Without it the check `image_attribution` has nothing to hold the images to.
   */
  imageAttribution?: { aerial: string[]; terrain: string[] };
  /** Build warnings (`buildWarnings`), passed into the report. */
  warnings?: Finding[];
};

const METRES_PER_NM = 1852;
const WEATHER_POINT_ID = /^wp_[0-9A-HJKMNP-TV-Z]{26}$/;
const URL_IN_TEXT = /\bhttps?:\/\/|\bwww\.[\p{L}\p{N}-]+\.\p{L}/iu;
/**
 * A bare domain name in a text (`example.com`, `sailing-guide.gr`, `a@b.eu`): a dotted word whose last label is one of
 * `validation.domainTlds`, word-bounded, lowercase (so `geschützt.Es` is text). Not "any dotted word", so `Ag.Nikolaos` and a missing space after a full stop
 * (`geschützt.Es`) stay text. Returns the matched string, or null.
 */
function domainIn(text: string, tlds: readonly string[]): string | null {
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}])[\p{L}\p{N}][\p{L}\p{N}.-]*\.(?:${tlds.join("|")})(?![\p{L}\p{N}])`, "u");
  return re.exec(text)?.[0] ?? null;
}
const HARBOUR_KINDS = new Set(["port", "marina"]);

const SPOTS = "spots.json";
const REGIONS = "regions.json";
const WEATHER = "weather-points.json";
const MANIFEST = "manifest.json";

type Ctx = { pkg: DeliveryPackage; deps: ValidationDeps };
type Check = (ctx: Ctx) => Finding[] | Promise<Finding[]>;

const finding = (file: ContractFile, objectId: string | null, path: string | null, message: string): Finding => ({
  file,
  objectId,
  path,
  message,
});

const spotsOf = (pkg: DeliveryPackage) => pkg.files[SPOTS].spots;
const regionsOf = (pkg: DeliveryPackage) => pkg.files[REGIONS].regions;
const pointsOf = (pkg: DeliveryPackage) => pkg.files[WEATHER].points;
const fmt = (n: number) => String(Number(n.toFixed(2))).replace(".", ",");

/** Every file of the package with its data, the manifest first. */
function filesOf(pkg: DeliveryPackage): Array<[ContractFile, unknown]> {
  return [[MANIFEST, pkg.manifest], ...(Object.entries(pkg.files) as Array<[ContractFile, unknown]>).filter(([, d]) => d !== undefined)];
}

/** The id of the list entry a JSON pointer points into (`/spots/3/…` → `spots[3].id`). */
function objectIdAt(data: unknown, path: string): string | null {
  const [, list, index] = path.split("/");
  if (list === undefined || index === undefined || data === null || typeof data !== "object") return null;
  const entry = (data as Record<string, unknown>)[list];
  const item = Array.isArray(entry) ? (entry[Number(index)] as unknown) : undefined;
  const id = item !== null && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
  return typeof id === "string" ? id : null;
}

/** Spec 08: ajv against the published schema plus zod (strictness and the five decimals live only in zod, P23). */
const jsonSchema: Check = ({ pkg }) => {
  const out: Finding[] = [];
  for (const [file, data] of filesOf(pkg)) {
    for (const e of checkJsonSchema(file, data)) {
      out.push(finding(file, objectIdAt(data, e.path), e.path, `Schemaverstoß (JSON-Schema): ${e.message}`));
    }
    const parsed = CONTRACT_SCHEMAS[file].safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length === 0 ? "" : `/${issue.path.map(String).join("/")}`;
        out.push(finding(file, objectIdAt(data, path), path, `Schemaverstoß (zod): ${issue.message}`));
      }
    }
  }
  return out;
};

/** Unique across all files, with the prefix of its file (weather points `wp_`, ruling M6-P31). */
const ids: Check = ({ pkg }) => {
  const out: Finding[] = [];
  const seen = new Map<string, ContractFile>();
  const visit = (file: ContractFile, id: string, path: string, prefix: PublicIdPrefix | "wp") => {
    const valid = prefix === "wp" ? WEATHER_POINT_ID.test(id) : isPublicId(id, prefix);
    if (!valid) out.push(finding(file, id, path, `Kennung ohne gültiges Präfix ${prefix}_ und ULID`));
    const other = seen.get(id);
    if (other !== undefined) out.push(finding(file, id, path, `Kennung doppelt (auch in ${other})`));
    else seen.set(id, file);
  };
  const scope = pkg.manifest.scope;
  // the scope's own id may repeat elsewhere by design (the subdivision in its coverage entry, the home marina among the spots)
  const own = scope.type === "subdivision" ? scope.subdivision.id : scope.homeMarina.id;
  if (scope.type === "subdivision") visit(MANIFEST, own, "/scope/subdivision/id", "sd");
  else if (!isPublicId(own, "sp")) out.push(finding(MANIFEST, own, "/scope/homeMarina/id", "Kennung ohne gültiges Präfix sp_ und ULID"));
  pkg.manifest.coverage.forEach((c, i) => {
    if (scope.type === "subdivision" && c.id === own) return;
    visit(MANIFEST, c.id, `/coverage/${i}/id`, "sd");
  });
  pkg.manifest.areas.forEach((a, i) => visit(MANIFEST, a.id, `/areas/${i}/id`, "ar"));
  spotsOf(pkg).forEach((s, i) => visit(SPOTS, s.id, `/spots/${i}/id`, "sp"));
  regionsOf(pkg).forEach((r, i) => visit(REGIONS, r.id, `/regions/${i}/id`, "rg"));
  pointsOf(pkg).forEach((p, i) => visit(WEATHER, p.id, `/points/${i}/id`, "wp"));
  return out;
};

/**
 * Teil B "jede referenzierte ID … in derselben Lieferung": a spot's region and merge target, a region's spots and
 * parent, a weather point's region; and a landside fact's `subject.id` names an entry of the `nearby` of the same spot.
 */
const references: Check = ({ pkg }) => {
  const out: Finding[] = [];
  const spotIds = new Set(spotsOf(pkg).map((s) => s.id));
  const regionIds = new Set(regionsOf(pkg).map((r) => r.id));
  const missing = (file: ContractFile, objectId: string, path: string, ref: string, what: string) =>
    out.push(finding(file, objectId, path, `Verweis auf ${what} ${ref}, der nicht im Paket ist`));
  spotsOf(pkg).forEach((s, i) => {
    if (s.regionId != null && !regionIds.has(s.regionId)) missing(SPOTS, s.id, `/spots/${i}/regionId`, s.regionId, "die Region");
    if (s.mergedInto !== null && !spotIds.has(s.mergedInto)) missing(SPOTS, s.id, `/spots/${i}/mergedInto`, s.mergedInto, "den Spot");
    const nearby = new Set(s.nearby.map((n) => n.id));
    s.facts.forEach((f, j) => {
      if (f.subject.kind === "landside" && f.subject.id !== null && !nearby.has(f.subject.id)) {
        out.push(finding(SPOTS, s.id, `/spots/${i}/facts/${j}/subject/id`, `Fakt verweist auf ${f.subject.id}, das nicht in nearby desselben Spots steht`));
      }
    });
  });
  regionsOf(pkg).forEach((r, i) => {
    r.spotIds.forEach((s, j) => spotIds.has(s) || missing(REGIONS, r.id, `/regions/${i}/spotIds/${j}`, s, "den Spot"));
    if (r.parentId !== null && !regionIds.has(r.parentId)) {
      missing(REGIONS, r.id, `/regions/${i}/parentId`, r.parentId, "die Region");
    }
  });
  pointsOf(pkg).forEach((p, i) => {
    if (p.regionId !== null && !regionIds.has(p.regionId)) missing(WEATHER, p.id, `/points/${i}/regionId`, p.regionId, "die Region");
  });
  return out;
};

/** Teil B: in the bounding box and "höchstens 1,5 sm von Wasser entfernt (gegen coast.geojson geprüft)". */
const spotLocation: Check = ({ pkg, deps }) => {
  const [west, south, east, north] = pkg.manifest.bbox;
  const features = pkg.files["coast.geojson"].features;
  const land = features.flatMap((f) => (f.properties.kind === "land" && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") ? [f.geometry] : []));
  const coastline = features.flatMap((f) =>
    f.properties.kind === "coastline" && (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString") ? [f.geometry] : [],
  );
  const max = deps.cfg.validation.maxWaterDistanceNm;
  const out: Finding[] = [];
  spotsOf(pkg).forEach((s, i) => {
    const p: LonLat = s.position;
    const path = `/spots/${i}/position`;
    if (p.lon < west || p.lon > east || p.lat < south || p.lat > north) {
      out.push(finding(SPOTS, s.id, path, "Position außerhalb der Bounding Box des Landesteils"));
      return;
    }
    if (!land.some((g) => pointInPolygon(p, g))) return;
    const d = distanceToLinesNm(p, coastline);
    if (d > max) out.push(finding(SPOTS, s.id, path, `Position an Land, ${Number.isFinite(d) ? `${fmt(d)} sm` : "ohne Küstenlinie"} vom Wasser entfernt (höchstens ${fmt(max)} sm)`));
  });
  return out;
};

/**
 * Eight sectors 0–1, swell 0–1; a port or marina below `harbourMinShelter` in a sector needs a shelter source of
 * `harbourShelterSources` (text, observed or a review decision, ruling M6-D-R2). Excluded spots are skipped (their
 * shelter may be zero-filled, ruling M6-B-R3).
 */
const shelter: Check = ({ pkg, deps }) => {
  const min = deps.cfg.validation.harbourMinShelter;
  const accepted = new Set<string>(deps.cfg.validation.harbourShelterSources);
  const out: Finding[] = [];
  const inUnit = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
  spotsOf(pkg).forEach((s, i) => {
    if (s.exclude.excluded) return;
    const path = `/spots/${i}/shelter`;
    const sectors = s.shelter.sectors as Record<string, unknown>;
    const keys = Object.keys(sectors);
    if (keys.length !== SECTORS.length || !SECTORS.every((k) => k in sectors)) {
      out.push(finding(SPOTS, s.id, `${path}/sectors`, "Schutz braucht genau die acht Sektoren N bis NW"));
    }
    for (const k of keys) if (!inUnit(sectors[k])) out.push(finding(SPOTS, s.id, `${path}/sectors/${k}`, `Schutz im Sektor ${k} nicht zwischen 0 und 1`));
    if (!inUnit(s.shelter.swell)) out.push(finding(SPOTS, s.id, `${path}/swell`, "Schwellschutz nicht zwischen 0 und 1"));
    if (!HARBOUR_KINDS.has(s.kind)) return;
    const low = SECTORS.filter((k) => typeof sectors[k] === "number" && (sectors[k] as number) < min);
    const source = s.provenance["shelter"]?.source;
    if (low.length > 0 && (source === undefined || !accepted.has(source))) {
      out.push(
        finding(SPOTS, s.id, `${path}/sectors`, `Hafen mit Schutz unter ${fmt(min)} (${low.join(", ")}) ohne Beleg aus Text, Beobachtung oder Review`),
      );
    }
  });
  return out;
};

const limits: Check = ({ pkg, deps }) => {
  const out: Finding[] = [];
  const check = (s: Spot, i: number, key: "maxDraft" | "maxLength", [lo, hi]: number[], label: string) => {
    const v = s.limits[key];
    if (v !== null && (v < lo! || v > hi!)) out.push(finding(SPOTS, s.id, `/spots/${i}/limits/${key}`, `${label} ${fmt(v)} m außerhalb ${fmt(lo!)}–${fmt(hi!)} m`));
  };
  spotsOf(pkg).forEach((s, i) => {
    check(s, i, "maxDraft", deps.cfg.validation.maxDraftM, "Maximaler Tiefgang");
    check(s, i, "maxLength", deps.cfg.validation.maxLengthM, "Maximale Länge");
  });
  return out;
};

const excludeReason: Check = ({ pkg }) =>
  spotsOf(pkg).flatMap((s, i) =>
    s.exclude.excluded && s.exclude.reason === null ? [finding(SPOTS, s.id, `/spots/${i}/exclude/reason`, "Ausgeschlossen ohne Grund")] : [],
  );

const berthMonths: Check = ({ pkg }) =>
  spotsOf(pkg).flatMap((s, i) =>
    s.berth?.status === "seasonFull" && s.berth.months.length === 0
      ? [finding(SPOTS, s.id, `/spots/${i}/berth/months`, "„In der Saison voll“ ohne Monat")]
      : [],
  );

/** Pairs closer than `limitM`, each reported at the later object. */
function closePairs<T extends { id: string; position: LonLat }>(items: T[], limitM: number, same: (a: T, b: T) => boolean) {
  const pairs: Array<{ a: T; b: T; index: number; metres: number }> = [];
  items.forEach((b, index) => {
    for (const a of items.slice(0, index)) {
      const metres = distanceNm(a.position, b.position) * METRES_PER_NM;
      if (same(a, b) && metres < limitM) pairs.push({ a, b, index, metres });
    }
  });
  return pairs;
}

/**
 * Teil B "keine zwei Spots derselben Art näher als 150 m" among the spots a boat may use: merged and excluded spots
 * aside (an excluded place next to a confirmed one is a warning, not a duplicate, ruling M6-D-R2); blocks (ruling
 * M6-P15).
 */
const spotDuplicates: Check = ({ pkg, deps }) =>
  closePairs(
    spotsOf(pkg).filter((s) => s.mergedInto === null && !s.exclude.excluded),
    deps.cfg.validation.spotDuplicateM,
    (a, b) => a.kind === b.kind,
  ).map(
    ({ a, b, metres }) => finding(SPOTS, b.id, `/spots/${spotsOf(pkg).indexOf(b)}/position`, `Gleiche Art wie ${a.id}, nur ${Math.round(metres)} m entfernt`),
  );

type TextField = { file: ContractFile; objectId: string | null; path: string; text: string };

/**
 * The display texts the 15-word rule covers (spec 08), with their pointers: the free statements of the facts and the
 * landing descriptions, which come from archived documents, and the texts the build makes itself.
 */
function displayTexts(pkg: DeliveryPackage): TextField[] {
  const out: TextField[] = [];
  const add = (file: ContractFile, objectId: string | null, path: string, text: string | null | undefined) => {
    if (typeof text === "string" && text !== "") out.push({ file, objectId, path, text });
  };
  spotsOf(pkg).forEach((s, i) => {
    s.facts.forEach((f, j) => add(SPOTS, s.id, `/spots/${i}/facts/${j}/text`, f.text));
    s.landingPoints.forEach((l, j) => l.kind === "text" && add(SPOTS, s.id, `/spots/${i}/landingPoints/${j}/description`, l.description));
    (s.seasonNote ?? []).forEach((n, j) => add(SPOTS, s.id, `/spots/${i}/seasonNote/${j}/text`, n.text));
    (s.hazards ?? []).forEach((h, j) => add(SPOTS, s.id, `/spots/${i}/hazards/${j}/text`, h.text));
    add(SPOTS, s.id, `/spots/${i}/exclude/detail`, s.exclude.detail);
    (s.images ?? []).forEach((img, j) => add(SPOTS, s.id, `/spots/${i}/images/${j}/alt/de`, img.alt.de));
    add(SPOTS, s.id, `/spots/${i}/contact/vhf`, s.contact?.vhf);
    add(SPOTS, s.id, `/spots/${i}/contact/phone`, s.contact?.phone);
  });
  regionsOf(pkg).forEach((r, i) => add(REGIONS, r.id, `/regions/${i}/character/de`, r.character?.de));
  return out;
}

/** Names, also checked for links. */
function nameTexts(pkg: DeliveryPackage): TextField[] {
  const out: TextField[] = [];
  spotsOf(pkg).forEach((s, i) => {
    out.push({ file: SPOTS, objectId: s.id, path: `/spots/${i}/name`, text: s.name });
    (s.names ?? []).forEach((n, j) => out.push({ file: SPOTS, objectId: s.id, path: `/spots/${i}/names/${j}/name`, text: n.name }));
    s.facts.forEach((f, j) => {
      if (f.subject.kind === "landside" && f.subject.name !== null) out.push({ file: SPOTS, objectId: s.id, path: `/spots/${i}/facts/${j}/subject/name`, text: f.subject.name });
    });
    s.nearby.forEach((n, j) => {
      out.push({ file: SPOTS, objectId: s.id, path: `/spots/${i}/nearby/${j}/name`, text: n.name });
      (n.names ?? []).forEach((x, k) => out.push({ file: SPOTS, objectId: s.id, path: `/spots/${i}/nearby/${j}/names/${k}/name`, text: x.name }));
    });
  });
  regionsOf(pkg).forEach((r, i) => {
    out.push({ file: REGIONS, objectId: r.id, path: `/regions/${i}/name`, text: r.name });
    (r.names ?? []).forEach((n, j) => out.push({ file: REGIONS, objectId: r.id, path: `/regions/${i}/names/${j}/name`, text: n.name }));
  });
  pointsOf(pkg).forEach((p, i) => out.push({ file: WEATHER, objectId: p.id, path: `/points/${i}/name`, text: p.name }));
  return out;
}

/** The injected copy check failed (the database, not the package): the validation must not end in a verdict. */
class DependencyFailed extends Error {
  constructor(readonly original: unknown) {
    super("copy check failed");
  }
}

/**
 * Spec 08 / Teil B "kein Textfeld mit mehr als 15 Wörtern wörtlich aus einer Quelle": a copied run longer than
 * `maxCopiedWords` (16 words or more). The copy checks run at most `copyCheckConcurrency` at once; any failure of one,
 * also a synchronous throw, is the database's, not the package's (rethrown, the build retries).
 */
/** The longest copied run per text; a failing lookup is the database's (`DependencyFailed`), no verdict on the package. */
async function copiedRuns(texts: string[], deps: Pick<ValidationDeps, "findCopies" | "cfg">): Promise<Map<string, number>> {
  const { copyCheckConcurrency } = deps.cfg.validation;
  const unique = [...new Set(texts)];
  const runs = new Map<string, number>();
  let next = 0;
  // the first failure stops every worker: the build unwinds, no further query runs on its transaction
  let failed = false;
  const worker = async () => {
    while (!failed && next < unique.length) {
      const text = unique[next++]!;
      try {
        runs.set(text, await Promise.resolve().then(() => deps.findCopies(text)));
      } catch (e) {
        failed = true;
        throw new DependencyFailed(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(copyCheckConcurrency, unique.length) }, worker));
  return runs;
}

const verbatimText: Check = async ({ pkg, deps }) => {
  const { maxCopiedWords } = deps.cfg.validation;
  const fields = displayTexts(pkg);
  const runs = await copiedRuns(fields.map((f) => f.text), deps);
  return fields.flatMap((f) =>
    runs.get(f.text)! > maxCopiedWords
      ? [finding(f.file, f.objectId, f.path, `Text enthält eine wörtliche Passage aus einer Quelle (mehr als ${maxCopiedWords} Wörter)`)]
      : [],
  );
};

/**
 * Final review F3: a fact or a landing description that fails `verbatim_text` or `foreign_content` (a copied run, a
 * link, a domain) is removed from its spot, with a warning (`fact_dropped`, `safety_fact_dropped`,
 * `landing_description_dropped`), instead of rejecting the whole subdivision package. Runs on the mapped spots before
 * versions; the checks still run over the finished package, so every other violation (a domain in a name, a copied
 * hazard text) rejects as before. A failing copy lookup is the database's and is rethrown.
 */
export async function dropCopiedTexts(spots: Array<{ body: SpotBody; warnings: SpotWarning[] }>, deps: Pick<ValidationDeps, "findCopies" | "cfg">): Promise<void> {
  const { maxCopiedWords } = deps.cfg.validation;
  let runs: Map<string, number>;
  try {
    runs = await copiedRuns(
      spots.flatMap((s) => [...s.body.facts.map((f) => f.text), ...s.body.landingPoints.flatMap((l) => (l.kind === "text" ? [l.description] : []))]),
      deps,
    );
  } catch (e) {
    throw e instanceof DependencyFailed ? e.original : e;
  }
  const bad = (text: string | null | undefined) =>
    typeof text === "string" && text !== "" && ((runs.get(text) ?? 0) > maxCopiedWords || foreignTextMessage(text, deps.cfg) !== null);
  for (const s of spots) {
    const facts = s.body.facts.filter((f) => {
      const drop = bad(f.text) || (f.subject.kind === "landside" && bad(f.subject.name));
      if (drop) s.warnings.push({ code: f.safety ? "safety_fact_dropped" : "fact_dropped", factId: f.id });
      return !drop;
    });
    const landingPoints = s.body.landingPoints.filter((l) => {
      const drop = l.kind === "text" && bad(l.description);
      if (drop) s.warnings.push({ code: "landing_description_dropped" });
      return !drop;
    });
    s.body = { ...s.body, facts, landingPoints };
  }
}

/**
 * Spec 13: the attribution of an AI illustration names the aerial and the terrain source it was made from (CC BY asks
 * for it), so an image whose attribution lacks either does not leave. Judged by the sources' configured attribution texts.
 */
const imageAttribution: Check = ({ pkg, deps }) => {
  const texts = deps.imageAttribution;
  if (!texts) return [];
  const out: Finding[] = [];
  const check = (file: ContractFile, id: string, base: string, images: Array<{ kind: string; attribution: string }> | undefined) =>
    (images ?? []).forEach((img, j) => {
      if (img.kind !== "ai_illustration") return;
      if (!texts.aerial.some((t) => img.attribution.includes(t))) out.push(finding(file, id, `${base}/images/${j}/attribution`, "Bildnachweis nennt keine Luftbildquelle"));
      if (!texts.terrain.some((t) => img.attribution.includes(t))) out.push(finding(file, id, `${base}/images/${j}/attribution`, "Bildnachweis nennt keine Geländequelle"));
    });
  spotsOf(pkg).forEach((s, i) => check(SPOTS, s.id, `/spots/${i}`, s.images));
  return out;
};

/** Why a text counts as foreign content (a link, a forbidden domain, a domain name), or null when it does not. */
function foreignTextMessage(text: string, cfg: DeliveryConfig): string | null {
  if (URL_IN_TEXT.test(text)) return "Text enthält einen Link";
  if (mentionsForbiddenDomain(text, cfg.forbiddenDomains)) return "Text nennt eine gesperrte Domain";
  const domain = domainIn(text, cfg.validation.domainTlds);
  return domain !== null ? `Text enthält einen Domainnamen (${domain})` : null;
}

/**
 * Teil B "Keine fremden Inhalte" (contract 4.0: no source, no URL, no domain anywhere): external refs are ids only; no
 * text (fact statements, landing descriptions, hints, names) holds a link, a domain-like string or a forbidden domain.
 */
const foreignContent: Check = ({ pkg, deps }) => {
  const out: Finding[] = [];
  const forbidden = deps.cfg.forbiddenDomains;
  const ref = (file: ContractFile, id: string, path: string, value: string | null | undefined, pattern: RegExp, label: string) => {
    if (value != null && !pattern.test(value)) out.push(finding(file, id, path, `${label} ist keine reine Kennung`));
  };
  spotsOf(pkg).forEach((s, i) => {
    const base = `/spots/${i}`;
    // the operator's own site is the one URL a spot may carry (contact); never one of a forbidden domain
    if (s.contact?.url != null && isForbiddenUrl(s.contact.url, forbidden)) out.push(finding(SPOTS, s.id, `${base}/contact/url`, "Kontaktadresse von einer gesperrten Domain"));
    ref(SPOTS, s.id, `${base}/externalRefs/osmId`, s.externalRefs?.osmId, OSM_ID_PATTERN, "OSM-Kennung");
    ref(SPOTS, s.id, `${base}/externalRefs/wikidataId`, s.externalRefs?.wikidataId, WIKIDATA_ID_PATTERN, "Wikidata-Kennung");
    for (const [category, list] of Object.entries(s.externalRefs?.googlePlaceIds ?? {})) {
      (list ?? []).forEach((g, j) => ref(SPOTS, s.id, `${base}/externalRefs/googlePlaceIds/${category}/${j}`, g, GOOGLE_PLACE_ID_PATTERN, "Google-Kennung"));
    }
  });
  for (const f of [...displayTexts(pkg), ...nameTexts(pkg)]) {
    const message = foreignTextMessage(f.text, deps.cfg);
    if (message !== null) out.push(finding(f.file, f.objectId, f.path, message));
  }
  return out;
};

/**
 * Teil B "dataVersion ist größer als die vorherige", "je Landesteil um 1 steigend": the previous one + 1 (1 for the first
 * package); every file's `scope` names the manifest's scope (type, subdivision or key, data version) and its schema.
 * A radius package has no data version of its own (its key stands for the versions it is made of).
 */
const dataVersion: Check = ({ pkg, deps }) => {
  const out: Finding[] = [];
  const m = pkg.manifest;
  const scope = m.scope;
  const previous = deps.previous?.dataVersion ?? null;
  if (scope.type === "subdivision") {
    const expected = (previous ?? 0) + 1;
    if (scope.dataVersion !== expected) {
      out.push(finding(MANIFEST, null, "/scope/dataVersion", `Datenversion ${scope.dataVersion} statt ${expected} (die vorige plus 1)`));
    }
    if (scope.previousDataVersion !== previous) {
      out.push(finding(MANIFEST, null, "/scope/previousDataVersion", `Vorige Datenversion ${scope.previousDataVersion ?? "keine"} statt ${previous ?? "keine"}`));
    }
  }
  const envelopes: Array<[ContractFile, { scope: FileScope; schemaVersion: string } | undefined]> = [
    [SPOTS, pkg.files[SPOTS]],
    [REGIONS, pkg.files[REGIONS]],
    [WEATHER, pkg.files[WEATHER]],
  ];
  for (const [file, e] of envelopes) {
    if (!e) continue;
    const head = e.scope;
    if (head.type !== scope.type) out.push(finding(file, null, "/scope/type", `Geltungsbereich ${head.type} statt ${scope.type} wie im Manifest`));
    else if (head.type === "subdivision" && scope.type === "subdivision") {
      if (head.id !== scope.subdivision.id) out.push(finding(file, null, "/scope/id", `Landesteil ${head.id} statt ${scope.subdivision.id} wie im Manifest`));
      if (head.dataVersion !== scope.dataVersion) out.push(finding(file, null, "/scope/dataVersion", `Datenversion ${head.dataVersion} statt ${scope.dataVersion} wie im Manifest`));
    } else if (head.type === "radius" && scope.type === "radius" && head.key !== scope.key) {
      out.push(finding(file, null, "/scope/key", `Schlüssel ${head.key} statt ${scope.key} wie im Manifest`));
    }
    if (e.schemaVersion !== m.schemaVersion) out.push(finding(file, null, "/schemaVersion", `Vertragsversion ${e.schemaVersion} statt ${m.schemaVersion} wie im Manifest`));
  }
  return out;
};

const CHECKS: Record<CheckName, Check> = {
  json_schema: jsonSchema,
  ids,
  references,
  spot_location: spotLocation,
  shelter,
  limits,
  exclude_reason: excludeReason,
  berth_months: berthMonths,
  spot_duplicates: spotDuplicates,
  verbatim_text: verbatimText,
  image_attribution: imageAttribution,
  foreign_content: foreignContent,
  data_version: dataVersion,
};

/**
 * Runs every check in `CHECK_NAMES` order (each listed, also when it passes); `ok` when none has a finding. A check
 * that throws on a package too broken for it reports that as its finding instead of hiding the other checks; a failing
 * copy check (`findCopies`) is rethrown, so the build fails and retries instead of rejecting the package.
 */
export async function validatePackage(pkg: DeliveryPackage, deps: ValidationDeps): Promise<ValidationReport> {
  const checks: ValidationReport["checks"] = [];
  for (const name of CHECK_NAMES) {
    let findings: Finding[];
    try {
      findings = await CHECKS[name]({ pkg, deps });
    } catch (e) {
      if (e instanceof DependencyFailed) throw e.original;
      findings = [finding(MANIFEST, null, null, `Prüfung nicht ausführbar: ${(e as Error).message}`)];
    }
    checks.push({ name, ok: findings.length === 0, findings });
  }
  return { ok: checks.every((c) => c.ok), checks, warnings: deps.warnings ?? [] };
}

const SPOT_OMITTED_DE: Record<"no_name" | "no_state" | "incomplete_core", string> = {
  no_name: "Nicht geliefert: kein gültiger Name",
  no_state: "Nicht geliefert: kein Stand",
  incomplete_core: "Nicht geliefert: Schutz oder Ankerposition fehlt im Stand",
};

const SPOT_WARNING_DE: Record<SpotWarning["code"], string> = {
  fallback_name: "Ausgeschlossener Spot ohne gültigen Namen, mit Ersatznamen geliefert",
  nearby_without_id: "Ding an Land ohne öffentliche ID, nicht geliefert",
  fact_without_subject: "Landfakt ohne Bezugsnamen, nicht geliefert",
  safety_fact_without_subject: "Sicherheitsfakt ohne Bezugsnamen, nicht geliefert: Sicherheitshinweis geht verloren",
  contact_url_foreign: "Kontaktadresse nicht von der eigenen Website des Platzes, nicht geliefert",
  fact_dropped: "Fakt mit wörtlich kopiertem Text oder fremdem Inhalt (Link, Domain), nicht geliefert",
  safety_fact_dropped: "Sicherheitsfakt mit wörtlich kopiertem Text oder fremdem Inhalt (Link, Domain), nicht geliefert: Sicherheitshinweis geht verloren",
  landing_description_dropped: "Anlandebeschreibung mit wörtlich kopiertem Text oder fremdem Inhalt (Link, Domain), nicht geliefert",
};

const WEATHER_DROPPED_DE: Record<DroppedWeatherPoint["reason"], string> = {
  no_name: "Nicht geliefert: kein Name",
  no_water: "Nicht geliefert: kein offenes Wasser in der Region",
};

/**
 * The build's report warnings (rulings M6-P31, M6-B-R1, M6-B-R3): values a spot was delivered without, spots
 * delivered with the fallback name, and every object left out of the package with its reason.
 */
export function buildWarnings(input: {
  spots?: Array<{ id: string; warnings: SpotWarning[] }>;
  omittedSpots?: Array<{ id: string; reason: keyof typeof SPOT_OMITTED_DE }>;
  /** Merged places of the previous package whose target is not delivered: removed, not carried (ruling M6-P14). */
  mergedNotCarried?: Array<{ id: string; into: string }>;
  droppedRegions?: Array<{ id: string; reason: "no_name" }>;
  droppedWeatherPoints?: DroppedWeatherPoint[];
  /** Non-excluded spots inside a military restricted area of the package's own coast (`spotsInMilitaryAreas`, M-7). */
  militaryAreaSpots?: string[];
}): Finding[] {
  const out: Finding[] = [];
  for (const s of input.spots ?? []) {
    for (const w of s.warnings) {
      out.push(finding(SPOTS, s.id, null, (w.code === "fact_dropped" || w.code === "safety_fact_dropped") ? `${SPOT_WARNING_DE[w.code]} (${w.factId})` : SPOT_WARNING_DE[w.code]));
    }
  }
  for (const s of input.omittedSpots ?? []) out.push(finding(SPOTS, s.id, null, SPOT_OMITTED_DE[s.reason]));
  for (const m of input.mergedNotCarried ?? []) {
    out.push(finding(SPOTS, m.id, null, `Zusammengelegt mit ${m.into}, das nicht geliefert wird: als entfernt gemeldet`));
  }
  for (const r of input.droppedRegions ?? []) out.push(finding(REGIONS, r.id, null, "Nicht geliefert: kein gültiger Name"));
  for (const w of input.droppedWeatherPoints ?? []) out.push(finding(WEATHER, weatherPointId(w.geoObjectId, w.kind), null, WEATHER_DROPPED_DE[w.reason]));
  for (const id of input.militaryAreaSpots ?? []) {
    out.push(finding(SPOTS, id, null, "Liegt in einem militärischen Sperrgebiet des Pakets (coast.geojson), ist aber nicht ausgeschlossen: Profil oder Status prüfen"));
  }
  return out;
}

/**
 * The delivered, non-excluded, unmerged spots whose position lies inside a `restrictedArea` of reason `military` of
 * the package's own `coast.geojson` (final review M-7): the package contradicts itself, which points to a stale profile
 * or place status. A warning, not a block: share thresholds may leave such a spot rightly unexcluded.
 */
export function spotsInMilitaryAreas(spots: Spot[], coast: CoastCollection): string[] {
  const areas = coast.features.flatMap((f) =>
    f.properties.kind === "restrictedArea" && f.properties.reason === "military" && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
      ? [f.geometry]
      : [],
  );
  if (areas.length === 0) return [];
  return spots
    .filter((s) => !s.exclude.excluded && s.mergedInto == null && areas.some((g) => pointInPolygon(s.position, g)))
    .map((s) => s.id);
}

/**
 * One line naming the failed checks of a report with their first `perCheck` findings (`<file> <object>: <message>`),
 * e.g. for a setup that expects a valid package (bundle H review); "none" when every check passed.
 */
export function failedChecksSummary(report: ValidationReport, perCheck = 3): string {
  const failed = report.checks.filter((c) => !c.ok);
  if (failed.length === 0) return "none";
  return failed
    .map((c) => {
      const shown = c.findings.slice(0, perCheck).map((f) => `${f.file}${f.objectId ? ` ${f.objectId}` : ""}: ${f.message}`);
      const more = c.findings.length > perCheck ? `; … ${c.findings.length - perCheck} more` : "";
      return `${c.name} (${shown.join("; ")}${more})`;
    })
    .join(", ");
}
