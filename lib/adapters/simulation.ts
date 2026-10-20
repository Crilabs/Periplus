import { getEnv } from "@/lib/env";
import type { Transport } from "./http";

/**
 * A simulated revisit (`PERIPLUS_SIMULATION`) tried to reach a paid or third-party service or the real network
 * (DataForSEO, Nominatim, Anthropic, Voyage, Jina, Firecrawl, a page fetch or render). Nothing was sent.
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
 * The guard every outgoing call of the adapter layer passes first: in a simulation it throws
 * `SimulationNetworkError` before anything is sent, booked or rate-limited.
 */
export function assertNotSimulated(service: string, what: string): void {
  if (simulationActive()) throw new SimulationNetworkError(service, what);
}

const offlineTransports = new WeakSet<Transport>();

/** Marks a transport that answers inside the process (the simulated one): `httpCall` lets it through in a simulation. */
export function markOffline<T extends Transport>(transport: T): T {
  offlineTransports.add(transport);
  return transport;
}

export function isOffline(transport: Transport): boolean {
  return offlineTransports.has(transport);
}
