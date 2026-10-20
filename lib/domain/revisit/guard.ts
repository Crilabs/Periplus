import type { Env } from "@/lib/env";

/** The only non-test database a simulated revisit may write to (a clone made by `scripts/sim/clone.sh`). */
export const SIMULATION_DATABASE = "periplus_sim";

/** A simulation pointed at a database it must never touch, or started without its own archive prefix. */
export class SimulationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationTargetError";
  }
}

/** The database name of a Postgres connection URL (empty when it names none). Never echoes the URL: it holds a password. */
export function databaseNameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SimulationTargetError("DATABASE_URL ist keine gültige Verbindungs-URL.");
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, ""));
}

/** True for the simulation clone and for test databases (`*_test`). */
export function isSimulationDatabase(name: string): boolean {
  return name === SIMULATION_DATABASE || /^[A-Za-z0-9_]+_test$/.test(name);
}

/**
 * Refuses every database but `periplus_sim` and `*_test`: a simulated revisit writes simulated versions and change
 * events and must never reach the real data. The message names the database, never the password.
 */
export function assertSimulationTarget(databaseUrl: string): void {
  const name = databaseNameOf(databaseUrl);
  if (!isSimulationDatabase(name)) {
    throw new SimulationTargetError(
      `Simulation nur gegen die Datenbank ${SIMULATION_DATABASE} oder eine Testdatenbank (*_test), nicht gegen „${name}“.`,
    );
  }
}

export type SimulationSettings = { scenarioPath: string; writePrefix: string; database: string };

/**
 * Start check of every process (worker, web): without `PERIPLUS_SIMULATION` nothing to check (null); with it the
 * database must be a simulation target and `S3_WRITE_PREFIX` must be set, else `SimulationTargetError` with a German
 * message. Returns what the process logs as `simulation active`.
 */
export function assertSimulationEnv(env: Pick<Env, "PERIPLUS_SIMULATION" | "DATABASE_URL" | "S3_WRITE_PREFIX">): SimulationSettings | null {
  if (!env.PERIPLUS_SIMULATION) return null;
  assertSimulationTarget(env.DATABASE_URL);
  if (!env.S3_WRITE_PREFIX) {
    throw new SimulationTargetError(
      "Simulation braucht S3_WRITE_PREFIX (z. B. sim/2026-10-20/), damit simulierte Archivobjekte nie neben den echten liegen.",
    );
  }
  return { scenarioPath: env.PERIPLUS_SIMULATION, writePrefix: env.S3_WRITE_PREFIX, database: databaseNameOf(env.DATABASE_URL) };
}
