import { applyEdit, scenarioUrlKey, type RevisitScenario, type ScenarioEntry } from "@/lib/domain/revisit/scenario";
import { makeResponse, type Transport } from "../http";
import { markOffline, SimulationNetworkError } from "../simulation";

export { SimulationNetworkError };

/** What the simulated web answers for one page. */
export type SimulatedResponse = { status: 304 } | { status: 404 } | { status: 200; markdown: string };

/**
 * The pages of a simulated revisit. `respond` takes the normalized URL and the Markdown of the document's newest
 * recorded (non-simulated) version, null when there is none; `covers` tells whether the scenario changes the URL (only
 * then the caller needs to load that version).
 */
export type SimulatedFetcher = {
  respond(urlNormalized: string, current: { markdown: string } | null): SimulatedResponse;
  covers(urlNormalized: string): boolean;
};

/**
 * A scenario URL answers 404 on every fetch when its edit is `gone`, else 200 with the edit applied to the recorded
 * Markdown (ruling M7-P9: the same text on every fetch); every other URL answers 304 (unchanged as recorded).
 */
export function createSimulatedFetcher(scenario: RevisitScenario): SimulatedFetcher {
  const entries = new Map<string, ScenarioEntry>(scenario.entries.map((e) => [scenarioUrlKey(e.url), e]));
  return {
    covers: (urlNormalized) => entries.has(urlNormalized),
    respond(urlNormalized, current) {
      const entry = entries.get(urlNormalized);
      if (!entry) return { status: 304 };
      if (entry.edit.op === "gone") return { status: 404 };
      if (!current) throw new Error(`scenario entry ${entry.id}: ${urlNormalized} has no recorded version to edit`);
      return { status: 200, markdown: applyEdit(current.markdown, entry.edit, entry.url) };
    },
  };
}

const NOT_FOUND = new Uint8Array(0);

/**
 * The transport of a simulated revisit: `/robots.txt` answers 404 (RFC 9309: everything allowed), every other
 * request is a `SimulationNetworkError` (no network in a simulation). `httpCall` lets it through the simulation guard.
 */
export const simulatedTransport: Transport = markOffline(async (req) => {
  if (new URL(req.url).pathname === "/robots.txt") return makeResponse(404, NOT_FOUND, { finalUrl: req.url });
  throw new SimulationNetworkError(req.service, `${req.operation} ${req.method ?? "GET"}`);
});
