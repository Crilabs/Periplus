import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { testArchive } from "@/test/s3";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { createGeonamesSource, fixtureGeonamesSource } from "@/lib/adapters/geonames";
import { newId } from "@/lib/domain/ids";
import { getConfig } from "@/lib/config";
import { externalCalls } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { Bbox } from "@/lib/domain/tiles";

const db = testDb();
const AEGINA_WEST: Bbox = [23.25, 37.5, 23.5, 37.75];
const cfg = () => ({ ...getConfig().gazetteer.geonames, baseUrl: `https://geonames.example.invalid/${newId()}` });

describe("fixture source", () => {
  const source = fixtureGeonamesSource();

  it("parses rows and filters by bbox and feature code", async () => {
    const rows = await source.rows("GR", AEGINA_WEST);
    const names = rows.map((r) => r.name);
    expect(names).toContain("Perdika");
    expect(names).toContain("Agistri");
    expect(names).not.toContain("Athens");
    expect(names).not.toContain("Poros");
    expect(names).not.toContain("Aegina Mountain Hut");
    const perdika = rows.find((r) => r.name === "Perdika");
    expect(perdika).toMatchObject({ id: "1001", asciiName: "Perdika", featureClass: "P", featureCode: "PPL", country: "GR" });
    expect(perdika?.lat).toBeCloseTo(37.6967, 4);
    expect(perdika?.lon).toBeCloseTo(23.4617, 4);
  });

  it("drops link/post alternate names and historic names", async () => {
    const alts = await source.alternateNames("GR", new Set(["1001", "1003"]));
    expect(alts.every((a) => ["1001", "1003"].includes(a.geonameId))).toBe(true);
    expect(alts.some((a) => a.language === "link" || a.language === "post" || a.language === "iata")).toBe(false);
    expect(alts.some((a) => a.name === "Aghistri")).toBe(false);
    expect(alts.find((a) => a.geonameId === "1001" && a.language === "el")).toMatchObject({
      name: "Πέρδικα",
      isPreferred: true,
      isHistoric: false,
    });
    expect(alts.find((a) => a.geonameId === "1001" && a.language === "de")?.isPreferred).toBe(false);
  });
});

describe("createGeonamesSource", () => {
  beforeAll(async () => {
    await testArchive().ensureBucket();
  });

  it("downloads once per month and reuses the archived zip", async () => {
    const main = readFileSync("test/fixtures/geonames/GR.txt");
    const alt = readFileSync("test/fixtures/geonames/GR-alternate.txt");
    const zips: Record<string, Uint8Array> = {
      "GR.zip": zipSync({ "GR.txt": main }),
      "alternatenames/GR.zip": zipSync({ "GR.txt": alt, "iso-languagecodes.txt": strToU8("x"), "readme.txt": strToU8("y") }),
    };
    const seen: HttpRequest[] = [];
    const transport: Transport = async (req) => {
      seen.push(req);
      const body = zips[req.url.endsWith("/alternatenames/GR.zip") ? "alternatenames/GR.zip" : "GR.zip"];
      return body ? makeResponse(200, body) : makeResponse(404, new Uint8Array());
    };
    const config = cfg();
    const runId = newId();
    // A random far-future month keeps the shared test bucket from satisfying the cache by accident.
    const now = new Date(Date.UTC(3000 + Math.floor(Math.random() * 6000), Math.floor(Math.random() * 12), 15));
    const make = () => createGeonamesSource({ transport, archive: testArchive(), ctx: { db, runId, stage: "geonames" }, cfg: config, now });

    const first = await make().rows("GR", AEGINA_WEST);
    const second = await make().rows("GR", AEGINA_WEST);
    expect(second).toEqual(first);
    expect(first.map((r) => r.name)).toContain("Perdika");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${config.baseUrl}/GR.zip`);

    const alts = await make().alternateNames("GR", new Set(["1001"]));
    await make().alternateNames("GR", new Set(["1001"]));
    expect(alts.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.url).toBe(`${config.baseUrl}/alternatenames/GR.zip`);

    const calls = await db.select().from(externalCalls).where(eq(externalCalls.runId, runId));
    expect(calls.map((c) => c.service)).toEqual(["geonames", "geonames"]);
  });
});
