import { CONTRACT_SCHEMAS, type CoastCollection, type ContractFile, type Highlight, type Spot } from "@/contract";
import { GOOGLE_PLACE_ID_PATTERN, highlightCategory, OSM_ID_PATTERN, WIKIDATA_ID_PATTERN } from "@/contract/v1";
import type { DeliveryConfig } from "@/lib/config/schemas";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { isPublicId, type PublicIdPrefix } from "@/lib/domain/ids";
import { isForbiddenUrl, mentionsForbiddenDomain } from "@/lib/domain/sources/forbidden-domains";
import { distanceNm, distanceToLinesNm, pointInPolygon } from "./geo";
import type { DroppedHighlight } from "./map-highlight";
import type { UndeliveredSafety } from "./map-region";
import type { SpotWarning } from "./map-spot";
import { checkJsonSchema } from "./schema-check";
import type { DeliveryPackage, LonLat } from "./types";
import { weatherPointId, type DroppedWeatherPoint } from "./weather-points";

/*
 * Package validation (spec 08, Teil B "Validierung"): one named check per rule, each with its findings (file, object,
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
  "low_confidence_note",
  "highlight_radius",
  "spot_duplicates",
  "highlight_duplicates",
  "verbatim_text",
  "foreign_content",
  "data_version",
  "changes_complete",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type Finding = { file: ContractFile; objectId: string | null; path: string | null; message: string };
export type ValidationReport = { ok: boolean; checks: Array<{ name: CheckName; ok: boolean; findings: Finding[] }>; warnings: Finding[] };

export type ValidationDeps = {
  /** The area's previous valid package: its data version and the contract version of every object in it. */
  previous: { dataVersion: number; versions: Map<string, number> } | null;
  /** The longest run of words of the text copied from the archive (`findArchiveCopies(db, text).longestRun`). */
  findCopies: (text: string) => Promise<number>;
  /**
   * The links of forbidden domains behind each delivered spot, highlight and region (`mapSpot` / `mapHighlights` /
   * `draftArea` `regionForbiddenSources`): such an object's values may come from Navily or Google, so it blocks
   * (ruling M6-D-R2, final review I-2).
   */
  forbiddenSources: Array<{ file: "spots.json" | "highlights.json" | "regions.json"; objectId: string; urls: string[] }>;
  cfg: DeliveryConfig;
  /** Radius of meaning per importance 1–5, nautical miles (`consolidation.importance.radiusNm`). */
  radiusNm: number[];
  /** Build warnings (`buildWarnings`), passed into the report. */
  warnings?: Finding[];
};

const METRES_PER_NM = 1852;
const WEATHER_POINT_ID = /^wp_[0-9A-HJKMNP-TV-Z]{26}$/;
const URL_IN_TEXT = /\bhttps?:\/\/|\bwww\.[\p{L}\p{N}-]+\.\p{L}/iu;
const HARBOUR_KINDS = new Set(["port", "marina"]);
const PREFIX_OF = { spot: "sp", highlight: "hl", region: "rg" } as const;

const SPOTS = "spots.json";
const HIGHLIGHTS = "highlights.json";
const REGIONS = "regions.json";
const WEATHER = "weather-points.json";
const CHANGES = "changes.json";
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
const highlightsOf = (pkg: DeliveryPackage) => pkg.files[HIGHLIGHTS].highlights;
const regionsOf = (pkg: DeliveryPackage) => pkg.files[REGIONS].regions;
const pointsOf = (pkg: DeliveryPackage) => pkg.files[WEATHER].points;
const changesOf = (pkg: DeliveryPackage) => pkg.files[CHANGES]?.changes ?? [];
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
  visit(MANIFEST, pkg.manifest.area.id, "/area/id", "ar");
  spotsOf(pkg).forEach((s, i) => visit(SPOTS, s.id, `/spots/${i}/id`, "sp"));
  highlightsOf(pkg).forEach((h, i) => visit(HIGHLIGHTS, h.id, `/highlights/${i}/id`, "hl"));
  regionsOf(pkg).forEach((r, i) => visit(REGIONS, r.id, `/regions/${i}/id`, "rg"));
  pointsOf(pkg).forEach((p, i) => visit(WEATHER, p.id, `/points/${i}/id`, "wp"));
  return out;
};

/** Teil B "jede referenzierte ID … in derselben Lieferung". */
const references: Check = ({ pkg }) => {
  const out: Finding[] = [];
  const spotIds = new Set(spotsOf(pkg).map((s) => s.id));
  const highlightIds = new Set(highlightsOf(pkg).map((h) => h.id));
  const regionIds = new Set(regionsOf(pkg).map((r) => r.id));
  const missing = (file: ContractFile, objectId: string, path: string, ref: string, what: string) =>
    out.push(finding(file, objectId, path, `Verweis auf ${what} ${ref}, der nicht im Paket ist`));
  spotsOf(pkg).forEach((s, i) => {
    (s.highlightIds ?? []).forEach((h, j) => highlightIds.has(h) || missing(SPOTS, s.id, `/spots/${i}/highlightIds/${j}`, h, "das Highlight"));
    if (s.regionId != null && !regionIds.has(s.regionId)) missing(SPOTS, s.id, `/spots/${i}/regionId`, s.regionId, "die Region");
    if (s.mergedInto !== null && !spotIds.has(s.mergedInto)) missing(SPOTS, s.id, `/spots/${i}/mergedInto`, s.mergedInto, "den Spot");
  });
  highlightsOf(pkg).forEach((h, i) => {
    h.spotIds.forEach((s, j) => spotIds.has(s) || missing(HIGHLIGHTS, h.id, `/highlights/${i}/spotIds/${j}`, s, "den Spot"));
    if (h.regionId != null && !regionIds.has(h.regionId)) missing(HIGHLIGHTS, h.id, `/highlights/${i}/regionId`, h.regionId, "die Region");
  });
  regionsOf(pkg).forEach((r, i) => {
    r.spotIds.forEach((s, j) => spotIds.has(s) || missing(REGIONS, r.id, `/regions/${i}/spotIds/${j}`, s, "den Spot"));
    if (r.parentId !== null && r.parentId !== pkg.manifest.area.id && !regionIds.has(r.parentId)) {
      missing(REGIONS, r.id, `/regions/${i}/parentId`, r.parentId, "die Region");
    }
  });
  pointsOf(pkg).forEach((p, i) => {
    if (p.regionId !== null && !regionIds.has(p.regionId)) missing(WEATHER, p.id, `/points/${i}/regionId`, p.regionId, "die Region");
  });
  const byType = { spot: spotIds, highlight: highlightIds, region: regionIds };
  changesOf(pkg).forEach((c, i) => {
    if (c.event !== "removed" && !byType[c.objectType].has(c.objectId)) missing(CHANGES, c.objectId, `/changes/${i}/objectId`, c.objectId, "das Objekt");
    // a removed object is not in the package: at least its id must fit its type
    if (c.event === "removed" && !isPublicId(c.objectId, PREFIX_OF[c.objectType])) {
      out.push(finding(CHANGES, c.objectId, `/changes/${i}/objectId`, `Kennung passt nicht zur Objektart ${c.objectType}`));
    }
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
      out.push(finding(SPOTS, s.id, path, "Position außerhalb der Bounding Box des Reviers"));
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

/** Teil B "score.confidence < 0,3 → summary.de mit „wenig belegt“"; spots and highlights (`mapSummary`). */
const lowConfidenceNote: Check = ({ pkg, deps }) => {
  const { lowConfidence, lowConfidenceNote: note } = deps.cfg.validation;
  const lacks = (o: Spot | Highlight) => o.score.confidence < lowConfidence && !(o.summary?.de ?? "").toLowerCase().includes(note.toLowerCase());
  const message = `Konfidenz unter ${fmt(lowConfidence)} ohne Hinweis „${note}“ in der Zusammenfassung`;
  return [
    ...spotsOf(pkg).flatMap((s, i) => (lacks(s) ? [finding(SPOTS, s.id, `/spots/${i}/summary`, message)] : [])),
    ...highlightsOf(pkg).flatMap((h, i) => (lacks(h) ? [finding(HIGHLIGHTS, h.id, `/highlights/${i}/summary`, message)] : [])),
  ];
};

/** A listed category and a delivered, unmerged, not excluded spot within the radius of meaning (ruling M6-P5). */
const highlightRadius: Check = ({ pkg, deps }) => {
  const counting = new Map(spotsOf(pkg).filter((s) => s.mergedInto === null && !s.exclude.excluded).map((s) => [s.id, s.position]));
  const categories = new Set<string>(highlightCategory.options);
  const out: Finding[] = [];
  highlightsOf(pkg).forEach((h, i) => {
    if (!categories.has(h.category)) out.push(finding(HIGHLIGHTS, h.id, `/highlights/${i}/category`, `Kategorie ${h.category} nicht in der Liste`));
    const radius = deps.radiusNm[h.importance - 1];
    const within = radius !== undefined && h.spotIds.some((id) => counting.has(id) && distanceNm(h.position, counting.get(id)!) <= radius);
    if (!within) {
      out.push(finding(HIGHLIGHTS, h.id, `/highlights/${i}/spotIds`, `Kein Spot im Bedeutungsradius (${radius === undefined ? "Bedeutung unbekannt" : `${fmt(radius)} sm`})`));
    }
  });
  return out;
};

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

/** Teil B "keine zwei Highlights gleichen Namens näher als 500 m" (normalized names). */
const highlightDuplicates: Check = ({ pkg, deps }) =>
  closePairs(highlightsOf(pkg), deps.cfg.validation.highlightDuplicateM, (a, b) => normalizeName(a.name) === normalizeName(b.name)).map(
    ({ a, b, index, metres }) => finding(HIGHLIGHTS, b.id, `/highlights/${index}/name`, `Gleicher Name wie ${a.id}, nur ${Math.round(metres)} m entfernt`),
  );

type TextField = { file: ContractFile; objectId: string | null; path: string; text: string };

/** The display texts the 15-word rule covers (spec 08), with their pointers. */
function displayTexts(pkg: DeliveryPackage): TextField[] {
  const out: TextField[] = [];
  const add = (file: ContractFile, objectId: string | null, path: string, text: string | null | undefined) => {
    if (typeof text === "string" && text !== "") out.push({ file, objectId, path, text });
  };
  spotsOf(pkg).forEach((s, i) => {
    add(SPOTS, s.id, `/spots/${i}/summary/de`, s.summary?.de);
    (s.seasonNote ?? []).forEach((n, j) => add(SPOTS, s.id, `/spots/${i}/seasonNote/${j}/text`, n.text));
    (s.hazards ?? []).forEach((h, j) => add(SPOTS, s.id, `/spots/${i}/hazards/${j}/text`, h.text));
    add(SPOTS, s.id, `/spots/${i}/exclude/detail`, s.exclude.detail);
  });
  highlightsOf(pkg).forEach((h, i) => add(HIGHLIGHTS, h.id, `/highlights/${i}/summary/de`, h.summary?.de));
  regionsOf(pkg).forEach((r, i) => add(REGIONS, r.id, `/regions/${i}/character/de`, r.character?.de));
  changesOf(pkg).forEach((c, i) => add(CHANGES, c.objectId, `/changes/${i}/summary/de`, c.summary.de));
  return out;
}

/** Names, also checked for links. */
function nameTexts(pkg: DeliveryPackage): TextField[] {
  const out: TextField[] = [];
  spotsOf(pkg).forEach((s, i) => {
    out.push({ file: SPOTS, objectId: s.id, path: `/spots/${i}/name`, text: s.name });
    (s.names ?? []).forEach((n, j) => out.push({ file: SPOTS, objectId: s.id, path: `/spots/${i}/names/${j}/name`, text: n.name }));
  });
  highlightsOf(pkg).forEach((h, i) => out.push({ file: HIGHLIGHTS, objectId: h.id, path: `/highlights/${i}/name`, text: h.name }));
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
const verbatimText: Check = async ({ pkg, deps }) => {
  const { maxCopiedWords, copyCheckConcurrency } = deps.cfg.validation;
  const fields = displayTexts(pkg);
  const texts = [...new Set(fields.map((f) => f.text))];
  const runs = new Map<string, number>();
  let next = 0;
  // the first failure stops every worker: the build unwinds, no further query runs on its transaction
  let failed = false;
  const worker = async () => {
    while (!failed && next < texts.length) {
      const text = texts[next++]!;
      try {
        runs.set(text, await Promise.resolve().then(() => deps.findCopies(text)));
      } catch (e) {
        failed = true;
        throw new DependencyFailed(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(copyCheckConcurrency, texts.length) }, worker));
  return fields.flatMap((f) =>
    runs.get(f.text)! > maxCopiedWords
      ? [finding(f.file, f.objectId, f.path, `Text enthält eine wörtliche Passage aus einer Quelle (mehr als ${maxCopiedWords} Wörter)`)]
      : [],
  );
};

/**
 * Teil B "Keine fremden Inhalte": external refs are ids only; no delivered spot, highlight or region draws on a document
 * of a forbidden domain (`deps.forbiddenSources`, ruling M6-D-R2, final review I-2) or lists one in `sources`; no text links to a page or
 * names a forbidden domain.
 */
const foreignContent: Check = ({ pkg, deps }) => {
  const out: Finding[] = [];
  const forbidden = deps.cfg.forbiddenDomains;
  const ref = (file: ContractFile, id: string, path: string, value: string | null | undefined, pattern: RegExp, label: string) => {
    if (value != null && !pattern.test(value)) out.push(finding(file, id, path, `${label} ist keine reine Kennung`));
  };
  const sources = (file: ContractFile, id: string, base: string, list: Array<{ url: string }> | undefined) =>
    (list ?? []).forEach((s, j) => {
      if (isForbiddenUrl(s.url, forbidden)) out.push(finding(file, id, `${base}/sources/${j}/url`, "Quelle von einer gesperrten Domain"));
    });
  spotsOf(pkg).forEach((s, i) => {
    const base = `/spots/${i}`;
    ref(SPOTS, s.id, `${base}/externalRefs/osmId`, s.externalRefs?.osmId, OSM_ID_PATTERN, "OSM-Kennung");
    ref(SPOTS, s.id, `${base}/externalRefs/wikidataId`, s.externalRefs?.wikidataId, WIKIDATA_ID_PATTERN, "Wikidata-Kennung");
    for (const [category, list] of Object.entries(s.externalRefs?.googlePlaceIds ?? {})) {
      (list ?? []).forEach((g, j) => ref(SPOTS, s.id, `${base}/externalRefs/googlePlaceIds/${category}/${j}`, g, GOOGLE_PLACE_ID_PATTERN, "Google-Kennung"));
    }
    sources(SPOTS, s.id, base, s.sources);
  });
  highlightsOf(pkg).forEach((h, i) => {
    const base = `/highlights/${i}`;
    ref(HIGHLIGHTS, h.id, `${base}/externalRefs/osmId`, h.externalRefs?.osmId, OSM_ID_PATTERN, "OSM-Kennung");
    ref(HIGHLIGHTS, h.id, `${base}/externalRefs/wikidataId`, h.externalRefs?.wikidataId, WIKIDATA_ID_PATTERN, "Wikidata-Kennung");
    ref(HIGHLIGHTS, h.id, `${base}/externalRefs/googlePlaceId`, h.externalRefs?.googlePlaceId, GOOGLE_PLACE_ID_PATTERN, "Google-Kennung");
    sources(HIGHLIGHTS, h.id, base, h.sources);
  });
  const delivered = {
    [SPOTS]: spotsOf(pkg).map((s) => s.id),
    [HIGHLIGHTS]: highlightsOf(pkg).map((h) => h.id),
    [REGIONS]: regionsOf(pkg).map((r) => r.id),
  };
  const listName = { [SPOTS]: "spots", [HIGHLIGHTS]: "highlights", [REGIONS]: "regions" } as const;
  for (const f of deps.forbiddenSources) {
    const i = delivered[f.file].indexOf(f.objectId);
    if (i < 0) continue; // left out of the package
    const list = listName[f.file];
    for (const url of f.urls) out.push(finding(f.file, f.objectId, `/${list}/${i}`, `Werte aus einer Quelle einer gesperrten Domain (${url})`));
  }
  for (const f of [...displayTexts(pkg), ...nameTexts(pkg)]) {
    if (URL_IN_TEXT.test(f.text)) out.push(finding(f.file, f.objectId, f.path, "Text enthält einen Link"));
    else if (mentionsForbiddenDomain(f.text, forbidden)) out.push(finding(f.file, f.objectId, f.path, "Text nennt eine gesperrte Domain"));
  }
  return out;
};

/**
 * Teil B "dataVersion ist größer als die vorherige", "je Revier um 1 steigend": the previous one + 1 (1 for the first
 * package); every file names the manifest's version, area and schema.
 */
const dataVersion: Check = ({ pkg, deps }) => {
  const out: Finding[] = [];
  const m = pkg.manifest;
  const previous = deps.previous?.dataVersion ?? null;
  const expected = (previous ?? 0) + 1;
  if (m.dataVersion !== expected) {
    out.push(finding(MANIFEST, null, "/dataVersion", `Datenversion ${m.dataVersion} statt ${expected} (die vorige plus 1)`));
  }
  if (m.previousDataVersion !== previous) {
    out.push(finding(MANIFEST, null, "/previousDataVersion", `Vorige Datenversion ${m.previousDataVersion ?? "keine"} statt ${previous ?? "keine"}`));
  }
  const envelopes: Array<[ContractFile, { dataVersion: number; area: string; schemaVersion: string } | undefined]> = [
    [SPOTS, pkg.files[SPOTS]],
    [HIGHLIGHTS, pkg.files[HIGHLIGHTS]],
    [REGIONS, pkg.files[REGIONS]],
    [WEATHER, pkg.files[WEATHER]],
    [CHANGES, pkg.files[CHANGES]],
  ];
  for (const [file, e] of envelopes) {
    if (!e) continue;
    if (e.dataVersion !== m.dataVersion) out.push(finding(file, null, "/dataVersion", `Datenversion ${e.dataVersion} statt ${m.dataVersion} wie im Manifest`));
    if (e.area !== m.area.id) out.push(finding(file, null, "/area", `Revier ${e.area} statt ${m.area.id} wie im Manifest`));
    if (e.schemaVersion !== m.schemaVersion) out.push(finding(file, null, "/schemaVersion", `Vertragsversion ${e.schemaVersion} statt ${m.schemaVersion} wie im Manifest`));
  }
  const changes = pkg.files[CHANGES];
  if (changes && previous !== null && changes.previousDataVersion !== previous) {
    out.push(finding(CHANGES, null, "/previousDataVersion", `Vorige Datenversion ${changes.previousDataVersion} statt ${previous}`));
  }
  return out;
};

/**
 * Teil B "changes.json enthält jedes Objekt, dessen profileVersion sich erhöht hat, und kein anderes": new or raised
 * objects and the previous ones missing now, each once, with the version in the package (a removed one above its
 * previous version).
 */
const changesComplete: Check = ({ pkg, deps }) => {
  const out: Finding[] = [];
  const file = pkg.files[CHANGES];
  if (deps.previous === null) {
    if (file) out.push(finding(CHANGES, null, null, "changes.json in der ersten Lieferung"));
    return out;
  }
  if (!file) return [finding(CHANGES, null, null, "changes.json fehlt, obwohl es eine vorige Lieferung gibt")];
  const versions = deps.previous.versions;
  const inPackage = new Map<string, number>(
    [...spotsOf(pkg), ...highlightsOf(pkg), ...regionsOf(pkg)].map((o) => [o.id, o.profileVersion]),
  );
  const expected = new Set<string>();
  for (const [id, v] of inPackage) if (!versions.has(id) || v > versions.get(id)!) expected.add(id);
  for (const id of versions.keys()) if (!inPackage.has(id)) expected.add(id);
  const listed = new Set<string>();
  file.changes.forEach((c, i) => {
    const path = `/changes/${i}`;
    if (listed.has(c.objectId)) out.push(finding(CHANGES, c.objectId, `${path}/objectId`, "Objekt mehrfach in changes.json"));
    listed.add(c.objectId);
    if (!expected.has(c.objectId)) {
      out.push(finding(CHANGES, c.objectId, `${path}/objectId`, "Eintrag ohne gestiegene Version"));
      return;
    }
    const v = inPackage.get(c.objectId);
    if (v !== undefined && c.profileVersion !== v) {
      out.push(finding(CHANGES, c.objectId, `${path}/profileVersion`, `Version ${c.profileVersion} statt ${v} wie im Paket`));
    }
    if (v === undefined && c.event !== "removed") out.push(finding(CHANGES, c.objectId, `${path}/event`, "Fehlendes Objekt nicht als entfernt gemeldet"));
    const before = versions.get(c.objectId);
    if (v === undefined && before !== undefined && c.profileVersion <= before) {
      out.push(finding(CHANGES, c.objectId, `${path}/profileVersion`, `Version ${c.profileVersion} nicht größer als die vorige (${before})`));
    }
  });
  for (const id of expected) if (!listed.has(id)) out.push(finding(CHANGES, id, null, "Geändertes, neues oder entferntes Objekt fehlt in changes.json"));
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
  low_confidence_note: lowConfidenceNote,
  highlight_radius: highlightRadius,
  spot_duplicates: spotDuplicates,
  highlight_duplicates: highlightDuplicates,
  verbatim_text: verbatimText,
  foreign_content: foreignContent,
  data_version: dataVersion,
  changes_complete: changesComplete,
};

/** Spots and highlights delivered without a summary (ruling M6-P9: "Zusammenfassung fehlt"). */
function packageWarnings(pkg: DeliveryPackage): Finding[] {
  return [
    ...spotsOf(pkg).flatMap((s, i) => (s.summary ? [] : [finding(SPOTS, s.id, `/spots/${i}/summary`, "Zusammenfassung fehlt")])),
    ...highlightsOf(pkg).flatMap((h, i) => (h.summary ? [] : [finding(HIGHLIGHTS, h.id, `/highlights/${i}/summary`, "Zusammenfassung fehlt")])),
  ];
}

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
  let own: Finding[] = [];
  try {
    own = packageWarnings(pkg);
  } catch {
    // a package too broken for the summary scan has its findings above
  }
  return { ok: checks.every((c) => c.ok), checks, warnings: [...(deps.warnings ?? []), ...own] };
}

const SPOT_OMITTED_DE: Record<"no_name" | "no_profile" | "shelter_incomplete", string> = {
  no_name: "Nicht geliefert: kein gültiger Name",
  no_profile: "Nicht geliefert: kein Profil",
  shelter_incomplete: "Nicht geliefert: Schutzwerte unvollständig oder ohne Herkunft",
};

const FIELD_DE: Record<"anchorPosition" | "depth" | "shelter", string> = { anchorPosition: "Ankerposition", depth: "Tiefe", shelter: "Schutz" };

const HIGHLIGHT_DROPPED_DE: Record<DroppedHighlight["reason"], string> = {
  no_name: "Nicht geliefert: kein gültiger Name",
  no_profile: "Nicht geliefert: kein Profil",
  not_existing: "Nicht geliefert: existiert laut Profil nicht mehr",
  no_importance: "Nicht geliefert: keine Bedeutung",
  no_spot_in_radius: "Nicht geliefert: kein Spot im Bedeutungsradius",
  duplicate: "Nicht geliefert: Dublette",
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
  droppedHighlights?: DroppedHighlight[];
  droppedRegions?: Array<{ id: string; reason: "no_name" }>;
  droppedWeatherPoints?: DroppedWeatherPoint[];
  /** Text-only safety values without a contract field (`undeliveredSafety`, final review I-3). */
  undeliveredSafety?: UndeliveredSafety[];
  /** Non-excluded spots inside a military restricted area of the package's own coast (`spotsInMilitaryAreas`, M-7). */
  militaryAreaSpots?: string[];
}): Finding[] {
  const out: Finding[] = [];
  for (const s of input.spots ?? []) {
    for (const w of s.warnings) {
      out.push(
        finding(
          SPOTS,
          s.id,
          null,
          w.code === "fallback_name"
            ? "Ausgeschlossener Spot ohne gültigen Namen, mit Ersatznamen geliefert"
            : w.field === "shelter"
              ? "Schutzwerte ohne Herkunft geliefert (ausgeschlossener Spot)"
              : `${FIELD_DE[w.field]} ohne Herkunft, nicht geliefert`,
        ),
      );
    }
  }
  for (const s of input.omittedSpots ?? []) out.push(finding(SPOTS, s.id, null, SPOT_OMITTED_DE[s.reason]));
  for (const m of input.mergedNotCarried ?? []) {
    out.push(finding(SPOTS, m.id, null, `Zusammengelegt mit ${m.into}, das nicht geliefert wird: als entfernt gemeldet`));
  }
  for (const h of input.droppedHighlights ?? []) {
    out.push(finding(HIGHLIGHTS, h.id, null, h.reason === "duplicate" && h.into ? `${HIGHLIGHT_DROPPED_DE.duplicate} von ${h.into}` : HIGHLIGHT_DROPPED_DE[h.reason]));
  }
  for (const r of input.droppedRegions ?? []) out.push(finding(REGIONS, r.id, null, "Nicht geliefert: kein gültiger Name"));
  for (const w of input.droppedWeatherPoints ?? []) out.push(finding(WEATHER, weatherPointId(w.geoObjectId, w.kind), null, WEATHER_DROPPED_DE[w.reason]));
  for (const u of input.undeliveredSafety ?? []) out.push(finding(u.file, u.id, null, u.message));
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
