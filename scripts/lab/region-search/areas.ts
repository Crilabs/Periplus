import type { Command } from "./cli";
import { mcpSqlAll } from "./mcp";
import { writeJson } from "./store";

/*
 * Areas (islands, gulfs, coast sections of GR-I) the region queries are built from. They come from the gazetteer,
 * never from the reference (spec, anti-goal 1).
 */

export type Area = { key: string; names: { en: string; de: string | null; el: string | null } };

export type Query = { area: string; lang: "en" | "de" | "el"; keyword: string };

/** Spec 5A. */
export const QUERY_TEMPLATES: Array<{ template: string; lang: "en" | "de" | "el" }> = [
  { template: "{area} anchorages", lang: "en" },
  { template: "{area} best anchorages sailing", lang: "en" },
  { template: "{area} cruising guide anchorages", lang: "en" },
  { template: "{area} sailing trip report anchored", lang: "en" },
  { template: "{area} Ankerplätze", lang: "de" },
  { template: "{area} Ankerbuchten Törnbericht", lang: "de" },
  { template: "{area} αγκυροβόλια", lang: "el" },
  { template: "{area} αγκυροβόλια ιστιοπλοΐα", lang: "el" },
];

/** Coast sections the gazetteer has no named object for (spec 4, assumption). */
export const AREAS_MANUAL: Area[] = [
  { key: "attica-west-coast", names: { en: "Vouliagmeni Sounion coast", de: "Küste Vouliagmeni Sounion", el: "Βουλιαγμένη Σούνιο" } },
  { key: "attica-east-coast", names: { en: "Lavrio Rafina coast", de: "Küste Lavrio Rafina", el: "Λαύριο Ραφήνα" } },
  { key: "methana", names: { en: "Methana", de: "Methana", el: "Μέθανα" } },
];

export function buildQueries(areas: Area[], templates = QUERY_TEMPLATES): Query[] {
  const seen = new Set<string>();
  const out: Query[] = [];
  for (const area of areas) {
    for (const t of templates) {
      const name = area.names[t.lang] ?? area.names.en;
      const keyword = t.template.replace("{area}", name);
      if (seen.has(keyword)) continue;
      seen.add(keyword);
      out.push({ area: area.key, lang: t.lang, keyword });
    }
  }
  return out;
}

type Row = { id: string; type: string; en: string | null; de: string | null; el: string | null; area_km2: number | string | null };

/** `Saronic Gulf` → `saronic-gulf`. */
export function areaKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Islands (≥ 5 km²), gulfs and coast sections of GR-I with their names in en/de/el (preferred name of the language,
 * else any), plus `AREAS_MANUAL` for coast sections the gazetteer does not name. Archipelagos are left out: in GR-I
 * they are groups of rocks (ruling, Task 2).
 */
export async function loadAreasFromGazetteer(): Promise<Area[]> {
  const rows = await mcpSqlAll<Row>(`
    select o.id, o.type::text as type,
      (select n.name from geo_names n where n.geo_object_id = o.id and n.valid_to is null and n.language = 'en' order by n.is_preferred desc, n.name limit 1) as en,
      (select n.name from geo_names n where n.geo_object_id = o.id and n.valid_to is null and n.language = 'de' order by n.is_preferred desc, n.name limit 1) as de,
      (select n.name from geo_names n where n.geo_object_id = o.id and n.valid_to is null and n.language = 'el' order by n.is_preferred desc, n.name limit 1) as el,
      round((st_area(o.geom::geography) / 1e6)::numeric, 1) as area_km2
    from geo_objects o join subdivisions s on s.id = o.subdivision_id
    where s.key = 'GR-I' and o.type in ('island', 'gulf', 'coast_section')
      and (o.type <> 'island' or st_area(o.geom::geography) >= 5e6)
    order by o.type, o.id`);
  const out: Area[] = [];
  const keys = new Set<string>();
  const push = (a: Area) => {
    if (keys.has(a.key)) return;
    keys.add(a.key);
    out.push(a);
  };
  for (const r of rows) {
    const en = r.en ?? r.de ?? r.el;
    if (!en) continue;
    push({ key: areaKey(en), names: { en, de: r.de, el: r.el } });
  }
  for (const a of AREAS_MANUAL) push({ ...a, key: areaKey(a.names.en) });
  return out;
}

export const areasCommand: Command = async (_args, dir) => {
  const areas = await loadAreasFromGazetteer();
  await writeJson(dir, "areas.json", areas);
  for (const a of areas) process.stdout.write(`${a.key.padEnd(26)} ${a.names.en} | ${a.names.de ?? "-"} | ${a.names.el ?? "-"}\n`);
  process.stdout.write(`${areas.length} areas, ${buildQueries(areas).length} queries → areas.json\n`);
};
