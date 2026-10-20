import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchOrganic } from "@/lib/adapters/dataforseo";
import { createPlaywrightRenderer } from "@/lib/adapters/fetch/browser";
import { createFirecrawlConverter } from "@/lib/adapters/fetch/firecrawl";
import { createGuardedTransport, guardedFetch, getGuardedAgent } from "@/lib/adapters/fetch/guarded";
import { createJinaConverter } from "@/lib/adapters/fetch/jina";
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

  it("refuses Nominatim", () =>
    withRollback(async (tx) => {
      const t = spyTransport();
      await expect(
        searchNominatim(t, { query: "Ormos", tileId: "q025:812:508", radiusKm: 10, limit: 5 }, { db: tx }, getConfig().extraction.geocode),
      ).rejects.toBeInstanceOf(SimulationNetworkError);
      expect(t.requests).toEqual([]);
    }));

  it("refuses Voyage", () =>
    withRollback(async (tx) => {
      const t = spyTransport();
      await expect(embedTexts(t, ["a bay"], { db: tx }, getConfig().embeddings)).rejects.toBeInstanceOf(SimulationNetworkError);
      expect(t.requests).toEqual([]);
    }));

  it("refuses Jina and Firecrawl", () =>
    withRollback(async (tx) => {
      const t = spyTransport();
      const cfg = getConfig().fetch;
      await expect(createJinaConverter(t, cfg.jina).convert(convertInput("https://example.org/a"), { db: tx })).rejects.toBeInstanceOf(
        SimulationNetworkError,
      );
      await expect(
        createFirecrawlConverter(t, cfg.firecrawl).convert(convertInput("https://example.org/a"), { db: tx }),
      ).rejects.toBeInstanceOf(SimulationNetworkError);
      expect(t.requests).toEqual([]);
    }));

  it("refuses Anthropic before the provider is asked", () =>
    withRollback(async (tx) => {
      const create = vi.fn();
      const api = { messages: { create, batches: { create, retrieve: create, results: create, cancel: create, list: create } } };
      const client = createAnthropicClient(tx, getConfig(), { sdk: api as unknown as AnthropicMessagesApi });
      await expect(client.call(echoTask, { text: "x" })).rejects.toBeInstanceOf(SimulationNetworkError);
      await expect(client.submitBatch(echoTask, [{ customId: "a", input: { text: "x" } }])).rejects.toBeInstanceOf(SimulationNetworkError);
      await expect(client.collectBatch(echoTask, "batch_1")).rejects.toBeInstanceOf(SimulationNetworkError);
      expect(create).not.toHaveBeenCalled();
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
      const t = spyTransport();
      for (const service of ["crawl", "overpass", "wikidata"]) {
        await expect(httpCall(t, { service, operation: "x", url: "https://example.org/", timeoutMs: 1000 }, { db: tx })).rejects.toBeInstanceOf(
          SimulationNetworkError,
        );
      }
      expect(t.requests).toEqual([]);
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
});
