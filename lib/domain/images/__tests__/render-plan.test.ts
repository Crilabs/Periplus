import { sql } from "drizzle-orm";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import { getConfig, type ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { landPolygons } from "@/lib/db/schema";
import { withRollback } from "@/test/db";
import type { PlaceImageInput } from "../place-input";
import {
  allowedZooms,
  baseAzimuth,
  cameraDetails,
  cameraFor,
  candidateAzimuths,
  foregroundPixelSize,
  inlandOffsetM,
  planRender,
  shoreDistance,
  titleZoomFor,
  type RenderCamera,
} from "../render-plan";

const cfg = getConfig().images;
const RAD = Math.PI / 180;

/** The inland offset of the camera-3 rule at `zoom`: `d − ds` with `d = h / tan(tilt)`, `ds = h / tan(tilt + shoreBelowCentreDeg)`. */
function inlandOf(zoom: ZoomLevel): number {
  const h = cfg.camera.zooms[zoom].heightM;
  return h / Math.tan(cfg.camera.tiltDeg * RAD) - h / Math.tan((cfg.camera.tiltDeg + cfg.composition.openWater.shoreBelowCentreDeg) * RAD);
}

/**
 * Image row (0 = top) of a ground point `groundDistanceM` from the camera ground point along the view direction: the
 * projection maths of `foregroundPixelSize` (focal length `f = (height/2) / tan(fov/2)`, a point at depression angle
 * `β = atan(h / x)` lands `f · tan(β − tilt)` below the image centre).
 */
function imageRow(camera: RenderCamera, groundDistanceM: number): number {
  const f = camera.height / 2 / Math.tan((camera.fovDeg / 2) * RAD);
  const beta = Math.atan(camera.heightM / groundDistanceM);
  return camera.height / 2 + f * Math.tan(beta - camera.tiltDeg * RAD);
}

/** Open sea west of the Peloponnese (outside the pilot box); rolled back. */
const LON = 19.37;
const LAT = 36.61;
/** Metres → degrees near LAT (WGS84 radii at 36.61° N). */
const M_LAT = 1 / 110_960;
const M_LON = 1 / 89_390;

function input(o: Partial<PlaceImageInput> = {}): PlaceImageInput {
  return {
    geoObjectId: "00000000-0000-7000-8000-000000000002",
    publicId: null,
    kind: "anchorage",
    lon: LON,
    lat: LAT,
    country: "GR",
    subdivisionKey: null,
    openingBearing: 90,
    rays: null,
    town: null,
    cove: null,
    ...o,
  };
}

function box(west: number, south: number, east: number, north: number): number[][] {
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}

async function insertLand(tx: Db, rings: number[][][]): Promise<void> {
  const polygon: Polygon = { type: "Polygon", coordinates: rings };
  await tx.insert(landPolygons).values({ geom: sql`${geomFromGeoJson(polygon)}`, datasetVersion: "test" });
}

/** 72 fetch rays (5° step) of `fetchM` everywhere, except at the bearings of `at` (bearing → metres). */
function rays(fetchM: number, at: Record<number, number> = {}): number[] {
  return Array.from({ length: 72 }, (_, i) => at[i * 5] ?? fetchM);
}

/** Geodesic distance and bearing from `from` to `to`. */
async function between(tx: Db, from: [number, number], to: [number, number]) {
  const { rows } = await tx.execute<{ distance: number; azimuth: number }>(sql`
    with c as (
      select ST_SetSRID(ST_MakePoint(${from[0]}::float8, ${from[1]}::float8), 4326)::geography as f,
             ST_SetSRID(ST_MakePoint(${to[0]}::float8, ${to[1]}::float8), 4326)::geography as t
    )
    select ST_Distance(f, t) as distance, degrees(ST_Azimuth(f, t)) as azimuth from c`);
  return { distance: Number(rows[0]!.distance), azimuth: Number(rows[0]!.azimuth) };
}

/** Camera ground point (`target` moved `distanceM` along `azimuthDeg`), its distance and azimuth from `from`. */
async function groundPoint(tx: Db, camera: RenderCamera, from: [number, number]) {
  const { rows } = await tx.execute<{ distance: number; azimuth: number }>(sql`
    with c as (
      select ST_Project(ST_SetSRID(ST_MakePoint(${camera.target[0]}::float8, ${camera.target[1]}::float8), 4326)::geography,
                        ${camera.distanceM}::float8, radians(${camera.azimuthDeg}::float8)) as p,
             ST_SetSRID(ST_MakePoint(${from[0]}::float8, ${from[1]}::float8), 4326)::geography as f
    )
    select ST_Distance(f, p) as distance, degrees(ST_Azimuth(f, p)) as azimuth from c`);
  return { distance: Number(rows[0]!.distance), azimuth: Number(rows[0]!.azimuth) };
}

describe("camera and zoom", () => {
  it("distance for z1 is 450 m and z2 277 m", () => {
    const z1 = cameraFor([LON, LAT], 90, "z1", cfg);
    expect(Math.abs(z1.distanceM - 450)).toBeLessThanOrEqual(1);
    expect(Math.abs(cameraFor([LON, LAT], 90, "z2", cfg).distanceM - 277)).toBeLessThanOrEqual(1);
    expect(z1).toEqual({
      target: [LON, LAT],
      azimuthDeg: 90,
      heightM: 260,
      distanceM: z1.distanceM,
      tiltDeg: 30,
      fovDeg: 50,
      width: 1536,
      height: 1024,
      zoom: "z1",
    });
  });

  it("0.5 m allows z1–z3; 10 m allows only z1", () => {
    expect(allowedZooms(0.5, cfg)).toEqual(["z1", "z2", "z3"]);
    expect(allowedZooms(10, cfg)).toEqual(["z1"]);
  });

  it("inland offset puts the shoreline on the lower-third line: 75 m at z2, 121 m at z1", () => {
    expect(Math.abs(inlandOffsetM("z2", cfg) - 75)).toBeLessThanOrEqual(1);
    expect(inlandOffsetM("z2", cfg)).toBeCloseTo(inlandOf("z2"), 9);
    expect(Math.abs(inlandOffsetM("z1", cfg) - 121)).toBeLessThanOrEqual(1);
  });

  it("title zoom: open water z2 with 0.5 m imagery, z1 with Sentinel-2 only, near town always the default z1", () => {
    const open = input();
    expect(titleZoomFor(open, 0.5, cfg)).toBe("z2");
    expect(titleZoomFor(open, 10, cfg)).toBe("z1");
    // before the imagery is known: the wanted zoom
    expect(titleZoomFor(open, null, cfg)).toBe("z2");
    const near = input({ town: { geoObjectId: "00000000-0000-7000-8000-000000000003", lon: LON, lat: LAT + 0.005 } });
    expect(titleZoomFor(near, 0.5, cfg)).toBe("z1");
    expect(titleZoomFor(near, null, cfg)).toBe("z1");
    // a closer wanted level falls back to the next allowed one: 0.7 m allows z1 and z2, not z3
    const z3 = { ...cfg, composition: { ...cfg.composition, openWater: { ...cfg.composition.openWater, zoom: "z3" as const } } };
    expect(allowedZooms(0.7, cfg)).toEqual(["z1", "z2"]);
    expect(titleZoomFor(open, 0.7, z3)).toBe("z2");
    expect(titleZoomFor(open, 0.5, z3)).toBe("z3");
  });

  it("foreground pixel size follows the camera tilt", () => {
    const at30 = foregroundPixelSize(0.5, "z1", cfg);
    expect(at30).toBeCloseTo(foregroundPixelSize(0.5, "z1", cfg, 30), 12);
    // f = 512 / tan 25° ≈ 1098; d = 260 / sin 55° ≈ 317.4
    expect(at30).toBeCloseTo((0.5 * (512 / Math.tan((25 * Math.PI) / 180))) / (260 / Math.sin((55 * Math.PI) / 180)), 9);
    // a flatter camera sees the foreground from farther away: smaller source pixels on screen
    expect(foregroundPixelSize(0.5, "z1", cfg, 18)).toBeLessThan(at30);
  });
});

describe("azimuths", () => {
  it("candidate azimuths alternate around the base in 10° steps", () => {
    const c = candidateAzimuths(355, 10);
    expect(c.slice(0, 6)).toEqual([355, 5, 345, 15, 335, 25]);
    expect(c).toHaveLength(36);
    expect(new Set(c).size).toBe(36);
    expect(c.at(-1)).toBe(175);
    expect(c.every((a) => a >= 0 && a < 360)).toBe(true);
  });

  it("null opening falls back to the longest ray", () => {
    const rays = Array.from({ length: 72 }, (_, i) => (i === 20 ? 9000 : 300));
    expect(baseAzimuth(null, rays, 5)).toBe(100);
    expect(baseAzimuth(42, rays, 5)).toBe(42);
    expect(baseAzimuth(null, null, 5)).toBeNull();
    expect(baseAzimuth(null, [], 5)).toBeNull();
  });
});

describe("shoreDistance", () => {
  it("reads the ray at the bearing and interpolates between neighbours, wrapping at north", () => {
    // ray i at i·10°: 100 m … 3600 m
    const r = Array.from({ length: 36 }, (_, i) => 100 * (i + 1));
    expect(shoreDistance(r, 130)).toBe(1400);
    expect(shoreDistance(r, 135)).toBe(1450);
    expect(shoreDistance(r, 355)).toBe((3600 + 100) / 2);
    expect(shoreDistance(r, 360)).toBe(100);
    expect(shoreDistance(r, -10)).toBe(3600);
    expect(shoreDistance(null, 10)).toBeNull();
    expect(shoreDistance([], 10)).toBeNull();
  });
});

describe("planRender", () => {
  it("looks from the opening when the camera is over water", async () => {
    await withRollback(async (tx) => {
      const plan = await planRender(tx, input(), "z1", cfg);
      expect(plan).toEqual({ ok: true, camera: cameraFor([LON, LAT], 90, "z1", cfg) });
    });
  });

  it("rotates until the camera is over water", async () => {
    await withRollback(async (tx) => {
      // covers the z1 camera ground points at 90° and 100° (450 m east, 0 and 78 m south), not the one at 80°
      await insertLand(tx, [box(LON + 400 * M_LON, LAT - 120 * M_LAT, LON + 500 * M_LON, LAT + 30 * M_LAT)]);
      const plan = await planRender(tx, input(), "z1", cfg);
      expect(plan.ok && plan.camera.azimuthDeg).toBe(80);
    });
  });

  it("open_water target lies S + inland behind the shore along the view direction", async () => {
    await withRollback(async (tx) => {
      // the reviewed case: camera side 310°, view 130°, shore 793 m ahead; at z1 the target is 121 m inland of it
      const plan = await planRender(tx, input({ openingBearing: 310, rays: rays(3000, { 130: 793 }) }), "z1", cfg);
      if (!plan.ok) throw new Error("expected a camera");
      const toTarget = await between(tx, [LON, LAT], plan.camera.target);
      expect(Math.abs(toTarget.distance - (793 + inlandOf("z1")))).toBeLessThanOrEqual(1);
      expect(toTarget.azimuth).toBeCloseTo(130, 1);
      expect(plan.camera).toEqual(cameraFor(plan.camera.target, 310, "z1", cfg));
      // the camera stands the zoom's 450 m before the target on its side (310°) …
      const fromTarget = await groundPoint(tx, plan.camera, plan.camera.target);
      expect(Math.abs(fromTarget.distance - 450)).toBeLessThanOrEqual(1);
      expect(fromTarget.azimuth).toBeCloseTo(310, 1);
      // … that is 464 m from the centre towards the shore, 329 m before the shoreline over the water of the bay
      const fromCentre = await groundPoint(tx, plan.camera, [LON, LAT]);
      expect(Math.abs(fromCentre.distance - (793 + inlandOf("z1") - 450))).toBeLessThanOrEqual(1);
      expect(fromCentre.azimuth).toBeCloseTo(130, 1);
    });
  });

  it("inland offset at z2: target = centre + S + 75 m", async () => {
    await withRollback(async (tx) => {
      // the PyVista test at a straight coast: shore 247 m ahead
      const plan = await planRender(tx, input({ rays: rays(3000, { 270: 247 }) }), "z2", cfg);
      if (!plan.ok) throw new Error("expected a camera");
      const toTarget = await between(tx, [LON, LAT], plan.camera.target);
      expect(Math.abs(toTarget.distance - (247 + 75))).toBeLessThanOrEqual(1);
      expect(toTarget.azimuth).toBeCloseTo(270, 1);
      expect(plan.camera.zoom).toBe("z2");
      expect(Math.abs(plan.camera.distanceM - 277)).toBeLessThanOrEqual(1);
    });
  });

  it("shoreline projects to the lower third of the image", async () => {
    await withRollback(async (tx) => {
      const plan = await planRender(tx, input({ rays: rays(3000, { 270: 247 }) }), "z2", cfg);
      if (!plan.ok) throw new Error("expected a camera");
      // the shoreline is 247 m west of the centre; its ground distance from the camera ground point along the view
      const shore: [number, number] = [LON - 247 * M_LON, LAT];
      const x = (await between(tx, cameraDetails(plan.camera).position, shore)).distance;
      expect(Math.abs(imageRow(plan.camera, x) / plan.camera.height - 2 / 3)).toBeLessThanOrEqual(0.03);
      // and the centre of the image shows the ground 75 m inland of it
      expect(Math.abs(imageRow(plan.camera, x + inlandOf("z2")) / plan.camera.height - 1 / 2)).toBeLessThanOrEqual(0.001);
    });
  });

  it("interpolates the shore distance between rays", async () => {
    await withRollback(async (tx) => {
      // 36 rays (10° step); view 135° lies midway between the rays at 130° (600 m) and 140° (1000 m): shore 800 m
      const r = Array.from({ length: 36 }, (_, i) => (i === 13 ? 600 : i === 14 ? 1000 : 3000));
      const plan = await planRender(tx, input({ openingBearing: 315, rays: r }), "z1", cfg);
      if (!plan.ok) throw new Error("expected a camera");
      const toTarget = await between(tx, [LON, LAT], plan.camera.target);
      expect(Math.abs(toTarget.distance - (800 + inlandOf("z1")))).toBeLessThanOrEqual(1);
      expect(toTarget.azimuth).toBeCloseTo(135, 1);
    });
  });

  it("shore farther than maxShoreM keeps the centre as target", async () => {
    await withRollback(async (tx) => {
      const atCentre = { ok: true, camera: cameraFor([LON, LAT], 90, "z1", cfg) };
      expect(await planRender(tx, input({ rays: rays(2001) }), "z1", cfg)).toEqual(atCentre);
      // at the limit the target still moves
      const plan = await planRender(tx, input({ rays: rays(2000) }), "z1", cfg);
      if (!plan.ok) throw new Error("expected a camera");
      expect(Math.abs((await between(tx, [LON, LAT], plan.camera.target)).distance - (2000 + inlandOf("z1")))).toBeLessThanOrEqual(1);
      // a close shore moves the target inland all the same (the camera then stands behind the centre)
      const close = await planRender(tx, input({ rays: rays(100) }), "z1", cfg);
      if (!close.ok) throw new Error("expected a camera");
      expect(Math.abs((await between(tx, [LON, LAT], close.camera.target)).distance - (100 + inlandOf("z1")))).toBeLessThanOrEqual(1);
    });
  });

  it("every shifted candidate on land falls back to the centre as target", async () => {
    await withRollback(async (tx) => {
      // shore 500 m in every direction: the shifted camera ground points lie 171 m from the centre (500 − 329 m) in
      // every direction, on a ring of land 120–220 m out; the centre-target camera 450 m out is over water
      await insertLand(tx, [
        box(LON - 220 * M_LON, LAT - 220 * M_LAT, LON + 220 * M_LON, LAT + 220 * M_LAT),
        box(LON - 120 * M_LON, LAT - 120 * M_LAT, LON + 120 * M_LON, LAT + 120 * M_LAT).reverse(),
      ]);
      expect(await planRender(tx, input({ rays: rays(500) }), "z1", cfg)).toEqual({ ok: true, camera: cameraFor([LON, LAT], 90, "z1", cfg) });
    });
  });

  it("no rays keeps the centre", async () => {
    await withRollback(async (tx) => {
      expect(await planRender(tx, input({ rays: null }), "z1", cfg)).toEqual({ ok: true, camera: cameraFor([LON, LAT], 90, "z1", cfg) });
      expect(await planRender(tx, input({ openingBearing: null, rays: [] }), "z1", cfg)).toEqual({ ok: true, camera: cameraFor([LON, LAT], 0, "z1", cfg) });
    });
  });

  it("rotated candidate recomputes the shore distance for its own view direction", async () => {
    await withRollback(async (tx) => {
      // Opening 90°: view 270° with the shore 800 m ahead puts the target 921 m west and the camera ground point 471 m
      // west of the centre (800 − 329 m), on a land strip 440–500 m west. The next candidate (100°, view 280°) finds
      // the shore at 1500 m: target 1621 m along 280°, camera 1171 m along 280°, over water. With the first candidate's
      // shore distance the camera at 100° would stand 471 m along 280°, on the strip again.
      await insertLand(tx, [box(LON - 500 * M_LON, LAT - 100 * M_LAT, LON - 440 * M_LON, LAT + 100 * M_LAT)]);
      const plan = await planRender(tx, input({ rays: rays(3000, { 270: 800, 280: 1500 }) }), "z1", cfg);
      if (!plan.ok) throw new Error("expected a camera");
      expect(plan.camera.azimuthDeg).toBe(100);
      const toTarget = await between(tx, [LON, LAT], plan.camera.target);
      expect(Math.abs(toTarget.distance - (1500 + inlandOf("z1")))).toBeLessThanOrEqual(1);
      expect(toTarget.azimuth).toBeCloseTo(280, 1);
      expect(Math.abs((await groundPoint(tx, plan.camera, [LON, LAT])).distance - (1500 + inlandOf("z1") - 450))).toBeLessThanOrEqual(1);
    });
  });

  it("azimuthOverride of a further view uses the bay-head rule too", async () => {
    await withRollback(async (tx) => {
      // override 180°: view 0° with the shore 500 m ahead → target 621 m north, whatever the opening says
      const plan = await planRender(tx, input({ openingBearing: 90, rays: rays(3000, { 0: 500 }) }), "z1", cfg, 180);
      if (!plan.ok) throw new Error("expected a camera");
      expect(plan.camera.azimuthDeg).toBe(180);
      const toTarget = await between(tx, [LON, LAT], plan.camera.target);
      expect(Math.abs(toTarget.distance - (500 + inlandOf("z1")))).toBeLessThanOrEqual(1);
      expect(Math.abs(toTarget.azimuth % 360)).toBeLessThan(0.1);
    });
  });

  describe("named cove", () => {
    /** The cove point 480 m east of the anchor point (the centre). */
    const COVE: [number, number] = [LON + 480 * M_LON, LAT];
    /** A straight coast 600 m east of the anchor point, running north–south `halfM` to either side. */
    const coast = (halfM = 500) => box(LON + 600 * M_LON, LAT - halfM * M_LAT, LON + 1000 * M_LON, LAT + halfM * M_LAT);
    /** `ds` of z2: the camera ground point stands this far before the shoreline. */
    const ds = () => cameraFor([LON, LAT], 0, "z2", cfg).distanceM - inlandOf("z2");

    it("cove target centres the named cove: on the line anchor → cove, inland of the shore behind it", async () => {
      await withRollback(async (tx) => {
        await insertLand(tx, [coast()]);
        // the opening says 90° (camera east); the cove says: camera over the anchorage, looking east at the cove
        const plan = await planRender(tx, input({ cove: COVE, openingBearing: 90, rays: rays(3000) }), "z2", cfg);
        if (!plan.ok) throw new Error("expected a camera");
        expect(plan.camera.azimuthDeg).toBe(270);
        const toTarget = await between(tx, [LON, LAT], plan.camera.target);
        expect(Math.abs(toTarget.distance - (600 + inlandOf("z2")))).toBeLessThanOrEqual(2);
        expect(toTarget.azimuth).toBeCloseTo(90, 1);
        // the camera stands over the anchorage: between the anchor point and the cove, `ds` before the shoreline
        const ground = await groundPoint(tx, plan.camera, [LON, LAT]);
        expect(Math.abs(ground.distance - (600 - ds()))).toBeLessThanOrEqual(2);
        expect(ground.azimuth).toBeCloseTo(90, 1);
        expect(ground.distance).toBeLessThan(480);
      });
    });

    it("rotates when the straight line to the cove puts the camera on an islet", async () => {
      await withRollback(async (tx) => {
        // an islet 380–420 m east of the anchor point, right where the camera of the straight view would stand
        await insertLand(tx, [coast()]);
        await insertLand(tx, [box(LON + 380 * M_LON, LAT - 20 * M_LAT, LON + 420 * M_LON, LAT + 20 * M_LAT)]);
        const plan = await planRender(tx, input({ cove: COVE, rays: rays(3000) }), "z2", cfg);
        if (!plan.ok) throw new Error("expected a camera");
        expect(plan.camera.azimuthDeg).toBe(280);
        // the shore along the view 100° (beyond the cove's distance) lies 600 / cos 10° = 609 m out
        const toTarget = await between(tx, [LON, LAT], plan.camera.target);
        expect(Math.abs(toTarget.distance - (600 / Math.cos(10 * RAD) + inlandOf("z2")))).toBeLessThanOrEqual(2);
        expect(toTarget.azimuth).toBeCloseTo(100, 1);
      });
    });

    it("every cove candidate on land falls back to the fetch rays, then to the centre", async () => {
      await withRollback(async (tx) => {
        // a short coast (±150 m) is seen by the views 80°, 90° and 100° only; a block of land 380–430 m east
        // (within the cove's 480 m, so no land search starts inside it) covers their camera ground points
        await insertLand(tx, [coast(150)]);
        await insertLand(tx, [box(LON + 380 * M_LON, LAT - 100 * M_LAT, LON + 430 * M_LON, LAT + 100 * M_LAT)]);
        // the rays rule: opening 180° (camera south, view north), shore 300 m north → target 375 m north
        const withRays = await planRender(tx, input({ cove: COVE, openingBearing: 180, rays: rays(300) }), "z2", cfg);
        if (!withRays.ok) throw new Error("expected a camera");
        expect(withRays.camera.azimuthDeg).toBe(180);
        const toTarget = await between(tx, [LON, LAT], withRays.camera.target);
        expect(Math.abs(toTarget.distance - (300 + inlandOf("z2")))).toBeLessThanOrEqual(1);
        expect(Math.abs(toTarget.azimuth % 360)).toBeLessThan(0.1);
        // without rays the centre is the target
        expect(await planRender(tx, input({ cove: COVE, openingBearing: 180 }), "z2", cfg)).toEqual({ ok: true, camera: cameraFor([LON, LAT], 180, "z2", cfg) });
      });
    });

    it("a cove without land within maxShoreM behind it has no cove candidates", async () => {
      await withRollback(async (tx) => {
        // open sea beyond the cove point: the rays rule (opening 90°, shore 500 m west) decides
        const plan = await planRender(tx, input({ cove: COVE, rays: rays(3000, { 270: 500 }) }), "z2", cfg);
        if (!plan.ok) throw new Error("expected a camera");
        expect(plan.camera.azimuthDeg).toBe(90);
        expect(Math.abs((await between(tx, [LON, LAT], plan.camera.target)).distance - (500 + inlandOf("z2")))).toBeLessThanOrEqual(1);
      });
    });

    it("azimuthOverride starts the cove rotation at the given side", async () => {
      await withRollback(async (tx) => {
        await insertLand(tx, [coast()]);
        // camera side 280° asked: view 100° towards the coast, the shore beyond the cove's distance
        const plan = await planRender(tx, input({ cove: COVE }), "z2", cfg, 280);
        if (!plan.ok) throw new Error("expected a camera");
        expect(plan.camera.azimuthDeg).toBe(280);
        expect((await between(tx, [LON, LAT], plan.camera.target)).azimuth).toBeCloseTo(100, 1);
      });
    });
  });

  it("enclosed place yields no_water_view", async () => {
    await withRollback(async (tx) => {
      // land ±3 km around the place with a 120 m pond: every camera ground point (z1 450 m, z3 173 m out) is on land
      await insertLand(tx, [
        box(LON - 3000 * M_LON, LAT - 3000 * M_LAT, LON + 3000 * M_LON, LAT + 3000 * M_LAT),
        box(LON - 120 * M_LON, LAT - 120 * M_LAT, LON + 120 * M_LON, LAT + 120 * M_LAT).reverse(),
      ]);
      expect(await planRender(tx, input(), "z1", cfg)).toEqual({ ok: false, reason: "no_water_view" });
      expect(await planRender(tx, input({ openingBearing: null }), "z3", cfg)).toEqual({ ok: false, reason: "no_water_view" });
      // with rays (the pond's edge 120 m out) the shifted targets and the centre fallback fail alike
      expect(await planRender(tx, input({ rays: rays(120) }), "z1", cfg)).toEqual({ ok: false, reason: "no_water_view" });
    });
  });

  it("near_town camera lies 450 m behind the anchorage, away from the town, and looks at the midpoint", async () => {
    await withRollback(async (tx) => {
      // Mikro Neorio / Poros (inside the pilot box: rollback only). The town lies ~960 m SSE, so the base azimuth
      // (town → centre) is ~342°; land north of 37.5083 blocks every candidate from 302° to 32°.
      const centre: [number, number] = [23.4501, 37.5067];
      const town = { geoObjectId: "00000000-0000-7000-8000-000000000003", lon: 23.4535, lat: 37.4985 };
      await insertLand(tx, [box(23.43, 37.5083, 23.47, 37.53)]);

      const plan = await planRender(tx, input({ lon: centre[0], lat: centre[1], openingBearing: 200, town }), "z1", cfg);
      if (!plan.ok) throw new Error("expected a camera");
      const { camera } = plan;

      expect(camera.target[0]).toBeCloseTo((centre[0] + town.lon) / 2, 9);
      expect(camera.target[1]).toBeCloseTo((centre[1] + town.lat) / 2, 9);
      expect(camera.heightM).toBe(260);
      expect(camera.zoom).toBe("z1");
      expect(camera.tiltDeg).toBeCloseTo((Math.atan(260 / camera.distanceM) * 180) / Math.PI, 9);
      expect(camera.tiltDeg).toBeGreaterThanOrEqual(15);
      expect(camera.tiltDeg).toBeLessThanOrEqual(22);

      const fromCentre = await groundPoint(tx, camera, centre);
      expect(Math.abs(fromCentre.distance - 450)).toBeLessThanOrEqual(1);
      expect(fromCentre.azimuth).toBeGreaterThanOrEqual(270);
      expect(fromCentre.azimuth).toBeLessThanOrEqual(300);
      // the camera ground point really is `distanceM` from the target
      const fromTarget = await groundPoint(tx, camera, camera.target);
      expect(Math.abs(fromTarget.distance - camera.distanceM)).toBeLessThanOrEqual(0.5);
    });
  });
});

describe("cameraDetails", () => {
  it("cameraDetails of an open_water z1 camera looks back at the target", () => {
    const cam = cameraFor([LON, LAT], 90, "z1", cfg);
    const d = cameraDetails(cam);
    // azimuth 90: the camera stands due east of the target, 450 m away, and looks west.
    expect(d.position[0] - LON).toBeCloseTo(cam.distanceM / 89_390, 5);
    expect(d.position[1]).toBeCloseTo(LAT, 6);
    expect(Math.abs(cam.distanceM - 450)).toBeLessThanOrEqual(1);
    expect(d.viewBearingDeg).toBeCloseTo(270, 9);
    expect(d.heightM).toBe(260);
    expect(d.tiltDeg).toBe(30);
    expect(d.fovDeg).toBe(cfg.camera.fovDeg);
    expect(cameraDetails(cameraFor([LON, LAT], 200, "z1", cfg)).viewBearingDeg).toBeCloseTo(20, 9);
  });
});
