import type { CategoriesConfig } from "@/lib/config";
import type { GeoObjectType, PoiCategory } from "@/lib/db/schema";
import { isGreek, normalizeName, type NameDraft } from "./names";

export type OsmClass = { type: GeoObjectType; category?: PoiCategory };

export type OsmElementType = "node" | "way" | "relation";

const LANGUAGE_NAME_KEY = /^name:([a-z]{2})$/;
const ALTERNATE_NAME_KEYS = ["int_name", "alt_name", "old_name"] as const;
const ISLAND_PLACES = new Set(["island", "islet", "archipelago"]);
const SETTLEMENT_PLACES = new Set(["town", "village", "hamlet"]);
const HARBOUR_SEAMARKS = new Set(["harbour", "small_craft_facility"]);
const ANCHORAGE_SEAMARKS = new Set(["anchorage", "mooring"]);
/** Normalized (see `normalizeName`) words that make a bay relation a gulf. */
const GULF_WORDS = ["gulf", "κολποσ"];

function hasName(tags: Record<string, string>): boolean {
  return Object.keys(tags).some((k) => k === "name" || k.startsWith("name:"));
}

function namedGulf(tags: Record<string, string>): boolean {
  return Object.entries(tags).some(
    ([k, v]) => (k === "name" || k.startsWith("name:")) && GULF_WORDS.some((w) => normalizeName(v).includes(w)),
  );
}

/**
 * Gazetteer type of an OSM object by its tags, first match wins: sea, gulf (also a bay relation named
 * "Gulf"/"Κόλπος"), island/islet/archipelago, cape, strait, peninsula (coast section), bay, harbour
 * (marina, harbour seamark, `harbour=*`), anchorage/mooring seamark (bay), town/village/hamlet
 * (settlement), then the first category rule (poi). Objects without `name`/`name:*` are null.
 */
export function classifyOsm(
  tags: Record<string, string>,
  categories: CategoriesConfig,
  elementType?: OsmElementType,
): OsmClass | null {
  if (!hasName(tags)) return null;
  const { place, natural, leisure, harbour } = tags;
  const seamark = tags["seamark:type"];

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
  if (tags.name) names.push({ name: tags.name, language: byScript(tags.name), origin: "osm" });
  for (const [key, value] of Object.entries(tags)) {
    const language = LANGUAGE_NAME_KEY.exec(key)?.[1];
    if (language && value) names.push({ name: value, language, origin: "osm" });
  }
  for (const key of ALTERNATE_NAME_KEYS) {
    for (const name of (tags[key] ?? "").split(";").map((s) => s.trim())) {
      if (name) names.push({ name, language: byScript(name), origin: "osm", isPreferred: false });
    }
  }
  return names;
}
