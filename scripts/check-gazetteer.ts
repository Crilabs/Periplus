import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import { areaByKey } from "../lib/config";
import { createDb, type Db } from "../lib/db/client";
import { geoNames, geoObjects, reviewTasks, tiles, type GeoObjectType } from "../lib/db/schema";
import { areaBbox } from "../lib/domain/gazetteer/areas";
import { validAt } from "../lib/domain/timeline";
import { tilesInBbox, type Bbox } from "../lib/domain/tiles";

const USAGE = "usage: check-gazetteer.ts --area <key>";
const REQUIRED_LANGUAGES = ["de", "en", "el"];
const CHECKED_TYPES: GeoObjectType[] = ["island", "islet", "settlement", "bay"];

export type GazetteerCheck = {
  tilesWithCoast: number;
  missing: Array<{ id: string; type: GeoObjectType; name: string; languages: string[] }>;
  openCandidateTasks: number;
};

/**
 * Acceptance check of the gazetteer inside `tileBbox`: every valid island, islet, settlement and named bay
 * whose centroid lies in the box needs one valid name each in de, en and el (`missing` lists the gaps with
 * the languages they do have), plus the number of valid coast tiles and open `place_candidate` tasks (places and pairs, not area-scoped:
 * the queue must be empty for acceptance).
 */
export async function checkGazetteer(db: Db, tileBbox: Bbox): Promise<GazetteerCheck> {
  const [west, south, east, north] = tileBbox;
  const inBox = sql`ST_Intersects(${geoObjects.centroid}, ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326))`;

  const objects = await db
    .select({ id: geoObjects.id, type: geoObjects.type })
    .from(geoObjects)
    .where(and(validAt(geoObjects), inArray(geoObjects.type, CHECKED_TYPES), inBox));
  const names = objects.length
    ? await db
        .select({ geoObjectId: geoNames.geoObjectId, name: geoNames.name, language: geoNames.language, isPreferred: geoNames.isPreferred })
        .from(geoNames)
        .where(and(validAt(geoNames), inArray(geoNames.geoObjectId, objects.map((o) => o.id))))
    : [];

  const byObject = new Map<string, typeof names>();
  for (const n of names) byObject.set(n.geoObjectId, [...(byObject.get(n.geoObjectId) ?? []), n]);

  const missing: GazetteerCheck["missing"] = [];
  for (const o of objects) {
    const own = byObject.get(o.id) ?? [];
    // An unnamed bay is not an anchorage candidate: only named bays are checked.
    if (o.type === "bay" && own.length === 0) continue;
    const languages = [...new Set(own.map((n) => n.language))].sort();
    if (REQUIRED_LANGUAGES.every((l) => languages.includes(l))) continue;
    const label = own.find((n) => n.isPreferred) ?? own[0];
    missing.push({ id: o.id, type: o.type, name: label?.name ?? "(ohne Namen)", languages });
  }
  missing.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const [coast] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tiles)
    .where(and(validAt(tiles), eq(tiles.hasCoast, true), inArray(tiles.id, tilesInBbox(tileBbox))));
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "place_candidate"), eq(reviewTasks.status, "open")));

  return { tilesWithCoast: coast!.n, missing, openCandidateTasks: open!.n };
}

export function parseArgs(argv: string[]): { area: string } {
  if (argv.length !== 2 || argv[0] !== "--area" || argv[1].startsWith("--")) throw new Error(USAGE);
  return { area: argv[1] };
}

async function main(): Promise<void> {
  const { area: key } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const area = areaByKey(key);
  const { db, close } = createDb(url);
  try {
    const r = await checkGazetteer(db, area.tileBbox ?? areaBbox(area));
    process.stdout.write(`tiles with coast: ${r.tilesWithCoast}\n`);
    process.stdout.write(`open candidate tasks: ${r.openCandidateTasks}\n`);
    process.stdout.write(`objects without de/en/el names: ${r.missing.length}\n`);
    for (const m of r.missing) {
      process.stdout.write(`  ${m.type} ${m.name} [${m.id}] has: ${m.languages.join(",") || "-"}\n`);
    }
    if (r.missing.length > 0) process.exitCode = 1;
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
