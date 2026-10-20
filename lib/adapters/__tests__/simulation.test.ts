import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchOrganic } from "@/lib/adapters/dataforseo";
import { createPlaywrightRenderer } from "@/lib/adapters/fetch/browser";
import { createFirecrawlConverter } from "@/lib/adapters/fetch/firecrawl";
import { createGuardedTransport, guardedFetch, getGuardedAgent } from "@/lib/adapters/fetch/guarded";
import { createJinaConverter } from "@/lib/adapters/fetch/jina";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { fetchTransport, httpCall, makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { searchNominatim } from "@/lib/adapters/nominatim";
import { markOffline, setSimulationMode, simulationActive, SimulationNetworkError } from "@/lib/adapters/simulation";
import { embedTexts } from "@/lib/adapters/voyage";
import { createAnthropicClient, type AnthropicMessagesApi } from "@/lib/ai/anthropic";
import { echoTask } from "@/lib/ai/tasks/system-echo";
import { getConfig } from "@/lib/config";
import { externalCalls } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { VOYAGE_RECORDING_TEXTS } from "@/scripts/fixtures-record";

/** A transport that would answer, and remembers whether anything was sent. */
function spyTransport(): Transport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest) => {
    requests.push(req);
    return makeResponse(200, new TextEncoder().encode("{}"));
  };
  return Object.assign(transport, { requests });
}

async function callsOfStage(tx: Db, stage: string) {
  return tx.select().from(externalCalls).where(eq(externalCalls.stage, stage));
}

const convertInput = (url: string) => ({
  url,
  html: null,
  boilerplateSelectors: [],
  render: "never" as const,
  rate: { key: "domain:example.org", perMinute: 1000 },
});

beforeEach(() => setSimulationMode(true));
afterEach(() => setSimulationMode(undefined));

describe("simulation guard", () => {
  it("is off unless PERIPLUS_SIMULATION is set", () => {
    setSimulationMode(undefined);
    expect(simulationActive()).toBe(false);
  });

  it("refuses DataForSEO before anything is sent or booked", () =>
    withRollback(async (tx) => {
      const stage = `sim-${newId()}`;
      const t = spyTransport();
      await expect(
        searchOrganic(t, { keyword: "Ormos", languageCode: "en", locationCode: 2300 }, { db: tx, stage }, getConfig().discovery.serp),
      ).rejects.toBeInstanceOf(SimulationNetworkError);
      expect(t.requests).toEqual([]);
      expect(await callsOfStage(tx, stage)).toEqual([]);
    }));

  it("refuses Nominatim before anything is sent or booked", () =>
    withRollback(async (tx) => {
      const stage = `sim-${newId()}`;
      const t = spyTransport();
      await expect(
        searchNominatim(t, { query: "Ormos", tileId: "q025:812:508", radiusKm: 10, limit: 5 }, { db: tx, stage }, getConfig().extraction.geocode),
      ).rejects.toBeInstanceOf(SimulationNetworkError);
      expect(t.requests).toEqual([]);
      expect(await callsOfStage(tx, stage)).toEqual([]);
    }));

  it("lets Voyage through, budget-checked and booked (ruling M7-P8)", () =>
    withRollback(async (tx) => {
      const stage = `sim-${newId()}`;
      const { vectors, tokens } = await embedTexts(
        fixtureTransport(),
        [...VOYAGE_RECORDING_TEXTS],
        { db: tx, stage },
        { ...getConfig().embeddings, ratePerMinute: 1_000_000 },
      );
      expect(vectors).toHaveLength(VOYAGE_RECORDING_TEXTS.length);
      const calls = await callsOfStage(tx, stage);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ service: "voyage", unit: "tokens", units: String(tokens) });
    }));

  it("refuses Jina and Firecrawl before anything is sent or booked", () =>
    withRollback(async (tx) => {
      const stage = `sim-${newId()}`;
      const t = spyTransport();
      const cfg = getConfig().fetch;
      await expect(
        createJinaConverter(t, cfg.jina).convert(convertInput("https://example.org/a"), { db: tx, stage }),
      ).rejects.toBeInstanceOf(SimulationNetworkError);
      await expect(
        createFirecrawlConverter(t, cfg.firecrawl).convert(convertInput("https://example.org/a"), { db: tx, stage }),
      ).rejects.toBeInstanceOf(SimulationNetworkError);
      expect(t.requests).toEqual([]);
      expect(await callsOfStage(tx, stage)).toEqual([]);
    }));

  it("lets Anthropic through, budget-checked and booked (ruling M7-P8)", () =>
    withRollback(async (tx) => {
      const stage = `sim-${newId()}`;
      const create = vi.fn(async () => ({
        content: [{ type: "text" as const, text: '{"echo":"x","language":"en"}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      }));
      const api = { messages: { create } } as unknown as AnthropicMessagesApi;
      // A day nothing else spent on, so the daily budget check sees only this call.
      const client = createAnthropicClient(tx, getConfig(), { sdk: api, now: () => new Date("2001-03-01T12:00:00Z") });
      const result = await client.call(echoTask, { text: "x" }, { stage });
      expect(result.output).toEqual({ echo: "x", language: "en" });
      expect(create).toHaveBeenCalledTimes(1);
      expect(await callsOfStage(tx, stage)).toMatchObject([{ service: "anthropic", unit: "tokens" }]);
    }));

  it("refuses real HTTP fetches of pages and services", async () => {
    // A closed loopback port: should the guard ever fail, nothing leaves the machine.
    const url = "http://127.0.0.1:9/";
    const req: HttpRequest = { service: "crawl", operation: "page", url, timeoutMs: 1000 };
    await expect(fetchTransport(req)).rejects.toBeInstanceOf(SimulationNetworkError);
    await expect(createGuardedTransport(getGuardedAgent())(req)).rejects.toBeInstanceOf(SimulationNetworkError);
    expect(() => guardedFetch(url, { dispatcher: getGuardedAgent() })).toThrow(SimulationNetworkError);
  });

  it("refuses every httpCall through a network transport, also free services", () =>
    withRollback(async (tx) => {
      const stage = `sim-${newId()}`;
      const t = spyTransport();
      for (const service of ["crawl", "overpass", "wikidata", "dataforseo", "nominatim", "jina", "firecrawl"]) {
        await expect(
          httpCall(t, { service, operation: "x", url: "https://example.org/", timeoutMs: 1000 }, { db: tx, stage }),
        ).rejects.toBeInstanceOf(SimulationNetworkError);
      }
      expect(t.requests).toEqual([]);
      expect(await callsOfStage(tx, stage)).toEqual([]);
    }));

  it("lets an offline transport through httpCall", () =>
    withRollback(async (tx) => {
      const t = markOffline(spyTransport());
      const res = await httpCall(t, { service: "crawl", operation: "robots", url: "https://example.org/robots.txt", timeoutMs: 1000 }, { db: tx });
      expect(res.status).toBe(200);
      expect(t.requests).toHaveLength(1);
    }));

  it("refuses to render a page without starting a browser", async () => {
    const launchBrowser = vi.fn();
    const renderer = createPlaywrightRenderer({ launchBrowser, isAllowed: async () => true });
    await expect(renderer.render("https://example.org/", { timeoutMs: 1000 })).rejects.toBeInstanceOf(SimulationNetworkError);
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("markOffline is used by the simulated transport only", () => {
    // Every other caller would let a network transport bypass the guard.
    const root = process.cwd();
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__" && e.name !== "node_modules") walk(path);
        } else if (/\.(ts|tsx)$/.test(e.name) && /\bmarkOffline\(/.test(readFileSync(path, "utf8"))) {
          users.push(relative(root, path));
        }
      }
    };
    for (const dir of ["app", "lib", "scripts", "worker"]) walk(join(root, dir));
    expect(users).toEqual(["lib/adapters/fetch/simulated.ts"]);
  });
});
