import type { Archive } from "@/lib/adapters/s3";
import { getConfig, type ImagesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { imageryTiles, placeImages, placeRenders, type ImagerySource } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { insertTestRun } from "@/test/text";
import type { DeliveryFixture } from "./subdivision";

/** Approved place images for delivery tests (spec 13): an image with its render, tiles and file in the archive. */

const imagesCfg = getConfig().images;
const bytesOf = (text: string) => new TextEncoder().encode(text);

const bbox = geomFromGeoJson({ type: "Polygon", coordinates: [[[21.0, 35.0], [21.1, 35.0], [21.1, 35.1], [21.0, 35.1], [21.0, 35.0]]] });

export type SeedImage = {
  /** Sources of the render's tiles; default Sentinel-2 and the DEM (the cadastre is not delivered). */
  sources?: ImagerySource[];
  blank?: ImagerySource[];
  slot?: string;
  rank?: number;
  sortOrder?: number;
  attribution?: string;
  alt?: string;
  geoObjectId?: string;
  content?: string;
};

/** An approved image of A (or `geoObjectId`) with its render and tiles, its file in `archive` under its `file_key`. */
export async function seedImage(tx: Db, f: DeliveryFixture, archive: Archive, o: SeedImage = {}) {
  const sources = o.sources ?? ["sentinel2", "copernicus_dem"];
  const geoObjectId = o.geoObjectId ?? f.places.A.geoObjectId;
  const tiles = [];
  for (const source of sources) {
    const configured = imagesCfg.sources[source as keyof ImagesConfig["sources"]];
    const [tile] = await tx
      .insert(imageryTiles)
      .values({
        source,
        tileKey: `t-${source}-${newId()}`,
        bbox,
        resolutionM: 10,
        license: configured.license,
        attribution: configured.attribution,
        fileKey: `imagery/${newId()}.jpg`,
        bytes: 10,
        blank: o.blank?.includes(source) ?? false,
      })
      .returning();
    tiles.push(tile!);
  }
  const [render] = await tx
    .insert(placeRenders)
    .values({
      geoObjectId,
      camera: { azimuth: 281.5 },
      zoom: "z1",
      imageryTileIds: tiles.filter((t) => t.source !== "copernicus_dem").map((t) => t.id),
      demTileIds: tiles.filter((t) => t.source === "copernicus_dem").map((t) => t.id),
      photoKey: "renders/p.png",
      maskKey: "renders/m.png",
      rendererVersion: "1",
      generationKey: `g-${newId()}`,
      runId: await insertTestRun(tx),
    })
    .returning();
  const id = newId();
  const fileKey = `images/places/${geoObjectId}/${id}.jpg`;
  await archive.put(fileKey, bytesOf(o.content ?? `jpeg-${id}`), "image/jpeg");
  const attribution =
    o.attribution ?? [...sources.filter((s) => !o.blank?.includes(s)).map((s) => imagesCfg.sources[s as keyof ImagesConfig["sources"]].attribution), imagesCfg.output.credit].join(" · ");
  const [row] = await tx
    .insert(placeImages)
    .values({
      id,
      geoObjectId,
      kind: "ai_illustration",
      slot: o.slot ?? "title",
      sortOrder: o.sortOrder ?? 0,
      rank: o.rank ?? 3,
      cameraPosition: geomFromGeoJson({ type: "Point", coordinates: [21.0449, 35.1201] }),
      cameraHeightM: 260,
      viewBearingDeg: 281.5,
      cameraTiltDeg: 18.2,
      cameraFovDeg: 50,
      renderId: render!.id,
      light: "midday",
      fileKey,
      width: 1536,
      height: 1024,
      alt: o.alt ?? "KI-Illustration: Bucht mit Hängen",
      generationKey: `k-${id}`,
      attribution,
      license: "periplus",
      observedAt: "2016-07-01",
    })
    .returning();
  return row!;
}

