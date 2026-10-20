import type { CategoriesConfig } from "@/lib/config";
import type { GeoObjectType, PoiCategory } from "@/lib/db/schema";
import { isGreek, normalizeName, type NameDraft } from "./names";

export type OsmClass = { type: GeoObjectType; category?: PoiCategory; adminLevel?: number };

export type OsmElementType = "node" | "way" | "relation";

const LANGUAGE_NAME_KEY = /^name:([a-z]{2})$/;
const ALTERNATE_NAME_KEYS = ["int_name", "alt_name", "old_name"] as const;
const ISLAND_PLACES = new Set(["island", "islet", "archipelago"]);
const SETTLEMENT_PLACES = new Set(["city", "town", "village", "hamlet"]);
const HARBOUR_SEAMARKS = new Set(["harbour", "small_craft_facility"]);
const ANCHORAGE_SEAMARKS = new Set(["anchorage", "mooring"]);
/** Normalized (see `normalizeName`) words that make a bay relation a gulf. */
const GULF_WORDS = ["gulf", "κολποσ"];

/** A name `osmNames` turns into a primary name: non-empty `name` or `name:<lang>`. */
function hasName(tags: Record<string, string>): boolean {
  return Object.entries(tags).some(([k, v]) => v.trim() !== "" && (k === "name" || LANGUAGE_NAME_KEY.test(k)));
}

function namedGulf(tags: Record<string, string>): boolean {
  return Object.entries(tags).some(
    ([k, v]) => (k === "name" || k.startsWith("name:")) && GULF_WORDS.some((w) => normalizeName(v).includes(w)),
  );
}

/**
 * Gazetteer type of an OSM object by its tags, first match wins: administrative boundary relation (spec 14:
 * `admin_level=2` country, other levels admin_region, carrying `adminLevel`), sea, gulf (also a bay relation named
 * "Gulf"/"Κόλπος"), island/islet/archipelago, cape, strait, peninsula (coast section), bay, harbour
 * (marina, harbour seamark, `harbour=*`), anchorage/mooring seamark (bay), city/town/village/hamlet
 * (settlement), then the first category rule (poi). Objects without a non-empty `name`/`name:<lang>` are null.
 */
export function classifyOsm(
  tags: Record<string, string>,
  categories: CategoriesConfig,
  elementType?: OsmElementType,
): OsmClass | null {
  if (!hasName(tags)) return null;
  const { place, natural, leisure, harbour } = tags;
  const seamark = tags["seamark:type"];

  if (elementType === "relation" && tags.boundary === "administrative" && /^[0-9]{1,2}$/.test(tags.admin_level ?? "")) {
    const adminLevel = Number(tags.admin_level);
    return { type: adminLevel === 2 ? "country" : "admin_region", adminLevel };
  }
  if (place === "sea") return { type: "sea" };
  if (place === "gulf") return { type: "gulf" };
  if (elementType === "relation" && natural === "bay" && namedGulf(tags)) return { type: "gulf" };
  if (place && ISLAND_PLACES.has(place)) return { type: place as GeoObjectType };
  if (natural === "cape") return { type: "cape" };
  if (natural === "strait") return { type: "strait" };
  if (natural === "peninsula") return { type: "coast_section" };
  if (natural === "bay") return { type: "bay" };
  if (leisure === "marina" || (seamark && HARBOUR_SEAMARKS.has(seamark)) || (harbour && harbour !== "no")) {
    return { type: "harbour" };
  }
  if (seamark && ANCHORAGE_SEAMARKS.has(seamark)) return { type: "bay" };
  if (place && SETTLEMENT_PLACES.has(place)) return { type: "settlement" };

  for (const rule of categories.osm) {
    const value = tags[rule.key];
    if (value === undefined) continue;
    if (rule.values === "*" || rule.values.includes(value)) return { type: "poi", category: rule.category };
  }
  return null;
}

/**
 * Names of an OSM object: `name:<lang>` with that language, `name` as `el` when Greek else `und`, then
 * `int_name`, `alt_name`, `old_name` (`;`-separated values split, language like `name`, never preferred).
 */
export function osmNames(tags: Record<string, string>): NameDraft[] {
  const byScript = (name: string) => (isGreek(name) ? "el" : "und");
  const names: NameDraft[] = [];
  if (tags.name?.trim()) names.push({ name: tags.name, language: byScript(tags.name), origin: "osm" });
  for (const [key, value] of Object.entries(tags)) {
    const language = LANGUAGE_NAME_KEY.exec(key)?.[1];
    if (language && value.trim()) names.push({ name: value, language, origin: "osm" });
  }
  for (const key of ALTERNATE_NAME_KEYS) {
    for (const name of (tags[key] ?? "").split(";").map((s) => s.trim())) {
      if (name) names.push({ name, language: byScript(name), origin: "osm", isPreferred: false });
    }
  }
  return names;
}
