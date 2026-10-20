import { getEnv } from "@/lib/env";
import type { Transport } from "./http";

/**
 * A simulated revisit (`PERIPLUS_SIMULATION`) tried to reach a paid or third-party service or the real network
 * (DataForSEO, Nominatim, Jina, Firecrawl, Overpass, a page fetch or render). Nothing was sent.
 */
export class SimulationNetworkError extends Error {
  constructor(
    readonly service: string,
    what: string,
  ) {
    super(`simulation: no ${service} call (${what}); a simulated revisit never leaves the process`);
    this.name = "SimulationNetworkError";
  }
}

let override: boolean | undefined;

/** Overrides `simulationActive()` (tests); `undefined` restores reading `PERIPLUS_SIMULATION`. */
export function setSimulationMode(active: boolean | undefined): void {
  override = active;
}

/** This process runs a simulated revisit: `PERIPLUS_SIMULATION` is set (or a test switched it on). */
export function simulationActive(): boolean {
  return override ?? getEnv().PERIPLUS_SIMULATION !== undefined;
}

/**
 * The services a simulation may reach (ruling M7-P8): the revisit's text stages extract and embed the changed chunks
 * with Anthropic and Voyage. Their calls stay budget-checked and booked in `external_calls` like any other.
 */
export const SIMULATION_ALLOWED_SERVICES: ReadonlySet<string> = new Set(["anthropic", "voyage"]);

/**
 * The guard every outgoing call of the adapter layer passes first: in a simulation it throws
 * `SimulationNetworkError` before anything is sent, booked or rate-limited, unless the service is one of
 * `SIMULATION_ALLOWED_SERVICES`.
 */
export function assertNotSimulated(service: string, what: string): void {
  if (simulationActive() && !SIMULATION_ALLOWED_SERVICES.has(service)) throw new SimulationNetworkError(service, what);
}

const offlineTransports = new WeakSet<Transport>();

/**
 * Marks a transport that answers inside the process (the simulated one): `httpCall` lets it through in a simulation.
 * This bypasses the simulation guard, so it is only for in-process transports, never for one that reaches the
 * network. `simulatedTransport` is its only user; `simulation.test.ts` fails when another module calls it.
 */
export function markOffline<T extends Transport>(transport: T): T {
  offlineTransports.add(transport);
  return transport;
}

export function isOffline(transport: Transport): boolean {
  return offlineTransports.has(transport);
}
