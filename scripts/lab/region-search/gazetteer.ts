import type { Command } from "./cli";
import { mcpSqlAll } from "./mcp";
import { readJson, writeJson } from "./store";

/*
 * Spec 5D step 2: the named objects of GR-I a mention can be matched against. Read from production through MCP `sql`
 * (500 rows per call); nothing from the reference.
 */

export type GazObject = { id: string; type: string; category: string | null; names: string[]; lon: number; lat: number; islandName: string | null };

type Row = { id: string; type: string; category: string | null; names: string | null; lon: number | string; lat: number | string; island_name: string | null };

export async function loadGazetteer(): Promise<GazObject[]> {
  const rows = await mcpSqlAll<Row>(`
    select o.id, o.type::text as type, o.category::text as category,
      (select string_agg(distinct n.name, '|') from geo_names n where n.geo_object_id = o.id and n.valid_to is null) as names,
      st_x(o.centroid) as lon, st_y(o.centroid) as lat,
      coalesce(
        (select n.name from geo_objects p join geo_names n on n.geo_object_id = p.id and n.valid_to is null
          where p.id = o.parent_id and p.type in ('island', 'islet') order by (n.language = 'en') desc, n.is_preferred desc, n.name limit 1),
        (select n.name from geo_objects p join geo_objects pp on pp.id = p.parent_id join geo_names n on n.geo_object_id = pp.id and n.valid_to is null
          where p.id = o.parent_id and pp.type in ('island', 'islet') order by (n.language = 'en') desc, n.is_preferred desc, n.name limit 1)
      ) as island_name
    from geo_objects o join subdivisions s on s.id = o.subdivision_id
    where s.key = 'GR-I'
      and (o.type in ('bay', 'harbour', 'cape', 'settlement', 'island', 'islet') or (o.type = 'poi' and o.category = 'beach'))
    order by o.id`);
  return rows
    .filter((r) => r.names)
    .map((r) => ({
      id: r.id,
      type: r.type,
      category: r.category,
      names: r.names!.split("|").filter(Boolean),
      lon: Number(r.lon),
      lat: Number(r.lat),
      islandName: r.type === "island" || r.type === "islet" ? r.names!.split("|")[0]! : r.island_name,
    }));
}

export async function readGazetteer(dir: string): Promise<GazObject[]> {
  const gaz = await readJson<GazObject[]>(dir, "gazetteer.json");
  if (!gaz) throw new Error("gazetteer.json missing: run `gazetteer` first");
  return gaz;
}

export const gazetteerCommand: Command = async (_args, dir) => {
  const gaz = await loadGazetteer();
  await writeJson(dir, "gazetteer.json", gaz);
  const byType: Record<string, number> = {};
  for (const g of gaz) byType[g.type] = (byType[g.type] ?? 0) + 1;
  process.stdout.write(`${gaz.length} objects → gazetteer.json\n${JSON.stringify(byType)}\n`);
};
