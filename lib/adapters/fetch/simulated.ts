import { applyEdit, scenarioUrlKey, type RevisitScenario, type ScenarioEntry } from "@/lib/domain/revisit/scenario";
import { makeResponse, type Transport } from "../http";
import { markOffline, SimulationNetworkError } from "../simulation";

export { SimulationNetworkError };

/** What the simulated web answers for one page. */
export type SimulatedResponse = { status: 304 } | { status: 404 } | { status: 200; markdown: string };

/** The version a scenario URL starts from: the document's current one, and whether it is itself simulated. */
export type SimulatedBase = { markdown: string; simulated: boolean };

/**
 * The pages of a simulated revisit. `respond` takes the normalized URL and the document's current version (null when
 * there is none); `covers` tells whether the scenario changes the URL (only then the caller needs to load that version).
 */
export type SimulatedFetcher = {
  respond(urlNormalized: string, current: SimulatedBase | null): SimulatedResponse;
  covers(urlNormalized: string): boolean;
};

/**
 * A scenario URL answers 404 on every fetch when its edit is `gone`. Otherwise it answers 200: with the edit applied to
 * the current version when that one was recorded (ruling M7-F-R3: the current version, also after a revert A → B → A),
 * or with the current version as it is when it is already simulated, i.e. carries the edit (ruling M7-P9: a repeated
 * fetch yields the same text, `unchanged`, instead of editing the edit). Every other URL answers 304 (as recorded).
 */
export function createSimulatedFetcher(scenario: RevisitScenario): SimulatedFetcher {
  const entries = new Map<string, ScenarioEntry>(scenario.entries.map((e) => [scenarioUrlKey(e.url), e]));
  return {
    covers: (urlNormalized) => entries.has(urlNormalized),
    respond(urlNormalized, current) {
      const entry = entries.get(urlNormalized);
      if (!entry) return { status: 304 };
      if (entry.edit.op === "gone") return { status: 404 };
      if (!current) throw new Error(`scenario entry ${entry.id}: ${urlNormalized} has no current version to edit`);
      if (current.simulated) return { status: 200, markdown: current.markdown };
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
