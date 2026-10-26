/**
 * Preview of the automatic title cameras of a subdivision (spec 19): the terrain render of every spot a run would
 * give a title image, without the image model and without recording anything. Fetches missing imagery like a run.
 *
 *   npx tsx --env-file=.env.local scripts/preview-title-renders.ts <subdivisionKey> [--out=<dir>] [--ids=<id>,<id>…]
 *
 * With `--ids` only those places (geo object ids), eligible or not.
 *
 * Writes `<out>/<kind>_<geoObjectId>.jpg` with a caption (kind, name, light, height, tilt); default out
 * `~/Downloads/ortsbilder-vorschau`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { lightFor } from "@/lib/domain/images/light";
import { loadPlaceImageInput } from "@/lib/domain/images/place-input";
import { planView } from "@/lib/domain/images/plan-view";
import { atTarget, initialZoom, resolveView, titleView } from "@/lib/pipeline/images/generate";
import { ensureImagery } from "@/lib/pipeline/images/imagery";
import { renderFromImagery } from "@/lib/pipeline/images/render";
import { subdivisionSpots } from "@/lib/pipeline/images/stage";

const escape = (s: string) => s.replace(/[<&>]/g, "");

async function main(): Promise<void> {
  const [key] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!key) throw new Error("usage: preview-title-renders.ts <subdivisionKey> [--out=<dir>]");
  const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? join(homedir(), "Downloads", "ortsbilder-vorschau");
  mkdirSync(out, { recursive: true });
  const db = getDb();
  const cfg = getConfig();
  const icfg = cfg.images;
  const archive = getArchive();
  const view = titleView();
  const only = process.argv.find((a) => a.startsWith("--ids="))?.slice(6).split(",").filter(Boolean);
  const ids = only ?? (await subdivisionSpots(db, key, cfg));
  console.log(`${ids.length} spots in ${key}`);
  for (const id of ids) {
    const place = await loadPlaceImageInput(db, id, icfg);
    if (!place || !place.country) continue;
    const country = place.country;
    const { rows } = await db.execute<{ name: string | null }>(sql`select name from geo_names where geo_object_id = ${id} order by is_preferred desc limit 1`);
    const name = escape(rows[0]?.name ?? "ohne Namen");
    try {
      const zoom = initialZoom(view, icfg);
      const plan = await planView(db, place, view, zoom, icfg);
      if (!plan.ok) {
        console.log(`${id} ${place.kind} ${name}: no water view`);
        continue;
      }
      const resolved = await resolveView(db, place, view, { zoom, camera: plan.camera }, icfg, (target) =>
        ensureImagery(db, archive, getTransport(), { geoObjectId: id, lon: target.lon, lat: target.lat, country, coreSizeM: target.coreSizeM }, { db, stage: "preview" }, icfg),
      );
      if (!resolved || !resolved.ok) {
        console.log(`${id} ${place.kind} ${name}: no water view at ${resolved?.zoom ?? "?"}`);
        continue;
      }
      const { camera, imagery } = resolved;
      const { photo } = await renderFromImagery(archive, atTarget(place, camera, icfg), camera, imagery, icfg);
      const light = lightFor(place, camera, icfg);
      const caption = `${place.kind} · ${name} · ${light === "evening" ? "Abend" : "Mittag"} · Höhe ${Math.round(camera.heightM)} m · Neigung ${camera.tiltDeg}°`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${camera.width}" height="${camera.height}"><rect x="0" y="${camera.height - 40}" width="${camera.width}" height="40" fill="rgba(0,0,0,0.55)"/><text x="14" y="${camera.height - 12}" font-family="Helvetica" font-size="24" fill="white">${caption}</text></svg>`;
      writeFileSync(join(out, `${place.kind}_${id}.jpg`), await sharp(photo).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 88 }).toBuffer());
      console.log(`${id} ${caption}`);
    } catch (e) {
      console.log(`${id} ${place.kind} ${name}: error ${String(e).slice(0, 200)}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
