import path from "node:path";
import { sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonSet, geoObjects, places } from "@/lib/db/schema";
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

  it("a broken navily file shows its path, never its content", () =>
    withRollback(async (tx) => {
      await setUp(tx);
      navilyPath = path.join(process.cwd(), "test/fixtures/navily/missing.json");
      const html = await render({ area: "saronic" });
      expect(html).toContain("Navily-Datei nicht lesbar");
      expect(html).toContain("missing.json");
    }));
});
