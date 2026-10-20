import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonSet, geoObjects, places, runs } from "@/lib/db/schema";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject } from "@/test/text";

let currentDb: Db = testDb();
let navilyPath: string | null = null;

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: async () => ({ email: "admin@example.invalid" }) }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/domain/quality/navily-assistant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/quality/navily-assistant")>();
  return { ...actual, loadNavilyFromEnv: () => actual.loadNavilyFromEnv({ NAVILY_SPOTS_PATH: navilyPath ?? undefined }) };
});

import Page from "../quality/compare/page";

const FIXTURE = path.join(process.cwd(), "test/fixtures/navily/sample.json");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "navily-page-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  currentDb = testDb();
  navilyPath = null;
});

/** A confirmed anchorage on the fixture's first spot (21.0° E / 35.2° N, outside the pilot box) in the saronic set. */
async function setUp(tx: Db): Promise<string> {
  currentDb = tx;
  let [area] = await tx
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(sql`${geoObjects.type} = 'area' and ${geoObjects.configKey} = 'saronic' and ${geoObjects.validTo} is null`);
  area ??= (
    await tx
      .insert(geoObjects)
      .values({ type: "area", origin: "manual", configKey: "saronic", geom: geomFromGeoJson({ type: "Point", coordinates: [24.61, 32.83] }) })
      .returning({ id: geoObjects.id })
  )[0]!;
  const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona-Testbucht" }], lon: 21.0, lat: 35.2 });
  const [place] = await tx
    .insert(places)
    .values({ geoObjectId: objectId, kind: "anchorage", status: "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
    .returning({ id: places.id });
  await tx.insert(comparisonSet).values({ placeId: place!.id, areaId: area.id, addedBy: "test" });
  await insertProfile(tx, objectId, { "services.water": false, "shelter.N": 0.9 }, { "shelter.N": provenanceEntry("computed") }, { version: 1 });
  return place!.id;
}

async function render(searchParams: Record<string, string>): Promise<string> {
  const tree = await Page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as PageProps<"/quality/compare">);
  return renderToStaticMarkup(tree);
}

describe("/quality/compare page", () => {
  it("without NAVILY_SPOTS_PATH compares by hand only", () =>
    withRollback(async (tx) => {
      const placeId = await setUp(tx);
      const html = await render({ area: "saronic", place: placeId });
      expect(html).toContain("NAVILY_SPOTS_PATH nicht gesetzt – Vergleich nur von Hand");
      expect(html).toContain("Kolona-Testbucht");
      expect(html).toContain(">bei Navily nicht vorhanden<");
      expect(html).not.toContain("Alle Vorschläge übernehmen");
      expect(html).not.toContain("Navily-Orte ohne Periplus-Ort");
    }));

  it("with a navily file shows runtime values, proposals and the unmatched spots", () =>
    withRollback(async (tx) => {
      const placeId = await setUp(tx);
      navilyPath = FIXTURE;
      const html = await render({ area: "saronic", place: placeId });
      expect(html).toContain("Navily-Datei geladen: 3 Spots (nur zur Laufzeit, nichts wird gespeichert)");
      expect(html).toContain("Alle Vorschläge übernehmen");
      expect(html).toContain("Spot „NAVILY-ONLY-NAME“");
      expect(html).toContain("Navily-Orte ohne Periplus-Ort");
      expect(html).toContain("wird nicht gespeichert");
    }));

  it("an unreadable navily file shows a generic notice: neither the server's path nor the file's content", () =>
    withRollback(async (tx) => {
      await setUp(tx);
      for (const [file, content] of [
        ["missing-navily.json", null],
        ["broken-navily.json", '[{"lat": "NAVILY-ONLY-NAME", "lon": 1}]'],
      ] as const) {
        navilyPath = path.join(dir, file);
        if (content !== null) await writeFile(navilyPath, content);
        const html = await render({ area: "saronic" });
        expect(html).toContain("Navily-Datei nicht lesbar");
        expect(html).toContain("Details stehen im Server-Log");
        expect(html).not.toContain(file);
        expect(html).not.toContain(dir);
        expect(html).not.toContain("NAVILY-ONLY-NAME");
        expect(html).not.toContain("Alle Vorschläge übernehmen");
      }
    }));

  it("the area chips keep the filter and the evaluation run", () =>
    withRollback(async (tx) => {
      await setUp(tx);
      const [run] = await tx
        .insert(runs)
        .values({ kind: "reprocess", scopeType: "system", scopeId: "test", triggeredBy: "test", params: { evaluation: true } })
        .returning({ id: runs.id });
      const html = await render({ area: "saronic", filter: "all", evaluation: run!.id });
      expect(html).toContain(`href="/quality/compare?area=argolic&amp;filter=all&amp;evaluation=${run!.id}"`);
    }));

  it("an unknown evaluation run is a 404", () =>
    withRollback(async (tx) => {
      await setUp(tx);
      const [plain] = await tx
        .insert(runs)
        .values({ kind: "reprocess", scopeType: "system", scopeId: "test", triggeredBy: "test" })
        .returning({ id: runs.id });
      for (const evaluation of ["0190a1b2-0000-7000-8000-00000000abcd", plain!.id, "not-a-uuid"]) {
        await expect(render({ area: "saronic", evaluation })).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
      }
    }));
});
