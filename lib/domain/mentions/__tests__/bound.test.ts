import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { placeWebsites, places, sources } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { boundGeoObjectFor } from "@/lib/domain/mentions/bound";
import { newId } from "@/lib/domain/ids";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";

/*
 * Spec 16 C „Bindung an den Ort“: the geo object a page URL is bound to, by the longest start URL among the places'
 * current website rows. Hosts are `<uuid>.example`, every row rolled back.
 */

const host = () => `${newId()}.example`;

async function website(tx: Db, p: { placeId: string; objectId: string }, url: string, o: { bound?: boolean; sourceId?: string; createdAt?: Date } = {}) {
  await tx.insert(placeWebsites).values({
    placeId: p.placeId,
    geoObjectId: p.objectId,
    url,
    urlNormalized: url,
    origin: "osm",
    bound: o.bound ?? true,
    sourceId: o.sourceId ?? null,
    ...(o.createdAt ? { createdAt: o.createdAt } : {}),
  });
}

describe("boundGeoObjectFor", () => {
  it("a page under a bound start URL is bound to its place, a page elsewhere is not", () =>
    withRollback(async (tx) => {
      const h = host();
      const a = await insertPlace(tx, { type: "harbour", name: "Alpha" });
      await website(tx, a, `https://${h}/en/`);
      expect(await boundGeoObjectFor(tx, `https://${h}/en/services/fuel`)).toBe(a.objectId);
      expect(await boundGeoObjectFor(tx, `https://${h}/en/`)).toBe(a.objectId);
      expect(await boundGeoObjectFor(tx, `https://${h}/de/`)).toBeNull();
      expect(await boundGeoObjectFor(tx, `https://other-${h}/en/`)).toBeNull();
    }));

  it("a start URL without a trailing slash matches on a path boundary only", () =>
    withRollback(async (tx) => {
      const h = host();
      const a = await insertPlace(tx, { type: "harbour", name: "Alpha" });
      await website(tx, a, `https://${h}/marina`);
      expect(await boundGeoObjectFor(tx, `https://${h}/marina/prices`)).toBe(a.objectId);
      expect(await boundGeoObjectFor(tx, `https://${h}/marina?lang=en`)).toBe(a.objectId);
      expect(await boundGeoObjectFor(tx, `https://${h}/marinas`)).toBeNull();
    }));

  it("the longest start URL wins (a chain's page under the other place's start URL)", () =>
    withRollback(async (tx) => {
      const h = host();
      const chain = await insertPlace(tx, { type: "harbour", name: "Chain HQ" });
      const local = await insertPlace(tx, { type: "harbour", name: "Local" });
      await website(tx, chain, `https://${h}/`);
      await website(tx, local, `https://${h}/marinas/local/`);
      expect(await boundGeoObjectFor(tx, `https://${h}/marinas/local/fuel`)).toBe(local.objectId);
      expect(await boundGeoObjectFor(tx, `https://${h}/marinas/other/fuel`)).toBe(chain.objectId);
    }));

  it("a start URL not bound (shared by several places) binds nothing, two places on the same URL tie", () =>
    withRollback(async (tx) => {
      const h = host();
      const a = await insertPlace(tx, { type: "harbour", name: "Alpha" });
      const b = await insertPlace(tx, { type: "harbour", name: "Beta" });
      await website(tx, a, `https://${h}/`, { bound: false });
      await website(tx, b, `https://${h}/`, { bound: false });
      expect(await boundGeoObjectFor(tx, `https://${h}/x`)).toBeNull();
      const h2 = host();
      const c = await insertPlace(tx, { type: "harbour", name: "Gamma" });
      const d = await insertPlace(tx, { type: "harbour", name: "Delta" });
      await website(tx, c, `https://${h2}/`);
      await website(tx, d, `https://${h2}/`);
      expect(await boundGeoObjectFor(tx, `https://${h2}/x`)).toBeNull();
    }));

  it("only the newest row of a place counts", () =>
    withRollback(async (tx) => {
      const h = host();
      const a = await insertPlace(tx, { type: "harbour", name: "Alpha" });
      await website(tx, a, `https://${h}/`, { createdAt: new Date("2026-01-01") });
      await website(tx, a, `https://${host()}/`, { createdAt: new Date("2026-02-01") });
      expect(await boundGeoObjectFor(tx, `https://${h}/x`)).toBeNull();
      const h2 = host();
      const b = await insertPlace(tx, { type: "harbour", name: "Beta" });
      await website(tx, b, `https://${h2}/`, { bound: true, createdAt: new Date("2026-01-01") });
      await website(tx, b, `https://${h2}/`, { bound: false, createdAt: new Date("2026-02-01") });
      expect(await boundGeoObjectFor(tx, `https://${h2}/x`)).toBeNull();
    }));

  it("a rejected place binds nothing, a merged place resolves to the survivor", () =>
    withRollback(async (tx) => {
      const h = host();
      const rejected = await insertPlace(tx, { type: "harbour", name: "Alpha", status: "rejected" });
      await website(tx, rejected, `https://${h}/`);
      expect(await boundGeoObjectFor(tx, `https://${h}/x`)).toBeNull();

      const h2 = host();
      const survivor = await insertPlace(tx, { type: "harbour", name: "Beta" });
      const merged = await insertPlace(tx, { type: "harbour", name: "Beta alt" });
      await tx.update(places).set({ mergedIntoId: survivor.placeId }).where(eq(places.id, merged.placeId));
      await website(tx, merged, `https://${h2}/`);
      expect(await boundGeoObjectFor(tx, `https://${h2}/x`)).toBe(survivor.objectId);
    }));

  it("a row of an authority source binds nothing even when marked bound", () =>
    withRollback(async (tx) => {
      const h = host();
      const [s] = await tx
        .insert(sources)
        .values({ domain: h, name: h, type: "authority", weight: 0.9, crawlRules: { ...DEFAULT_CRAWL_RULES }, origin: "manual" })
        .returning({ id: sources.id });
      const a = await insertPlace(tx, { type: "harbour", name: "Alpha" });
      await website(tx, a, `https://${h}/`, { sourceId: s!.id });
      expect(await boundGeoObjectFor(tx, `https://${h}/x`)).toBeNull();
    }));
});
