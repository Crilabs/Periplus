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
 * Start check of every process (worker, web, sim CLIs). With `PERIPLUS_SIMULATION` the database must be a simulation
 * target and `S3_WRITE_PREFIX` must be set; returns what the process logs as `simulation active`. Without it the
 * reverse holds: the simulation clone (`periplus_sim`) and an archive write prefix belong to a simulation only, so a
 * process on the clone without the simulation guard (real crawl, DataForSEO, Nominatim, unprefixed archive writes)
 * or one writing real objects under a prefix is refused; null otherwise. Refusals are `SimulationTargetError`s
 * with a German message.
 */
export function assertSimulationEnv(env: Pick<Env, "PERIPLUS_SIMULATION" | "DATABASE_URL" | "S3_WRITE_PREFIX">): SimulationSettings | null {
  if (!env.PERIPLUS_SIMULATION) {
    if (databaseNameOrNull(env.DATABASE_URL) === SIMULATION_DATABASE) {
      throw new SimulationTargetError(
        `Die Datenbank ${SIMULATION_DATABASE} ist der Simulationsklon: nur mit PERIPLUS_SIMULATION starten, sonst erreicht der Prozess echte Dienste.`,
      );
    }
    if (env.S3_WRITE_PREFIX) {
      throw new SimulationTargetError("S3_WRITE_PREFIX gehört zu einer Simulation: ohne PERIPLUS_SIMULATION nicht setzen.");
    }
    return null;
  }
  assertSimulationTarget(env.DATABASE_URL);
  if (!env.S3_WRITE_PREFIX) {
    throw new SimulationTargetError(
      "Simulation braucht S3_WRITE_PREFIX (z. B. sim/2026-10-20/), damit simulierte Archivobjekte nie neben den echten liegen.",
    );
  }
  return { scenarioPath: env.PERIPLUS_SIMULATION, writePrefix: env.S3_WRITE_PREFIX, database: databaseNameOf(env.DATABASE_URL) };
}

/**
 * `assertSimulationEnv` for a sim CLI (`sim:revisit`, `sim:verify`): refused also outside a simulation (null), so its
 * options never run against the real database (rulings M7-F-R2, M7-G-R4). The message names what this CLI's own
 * environment must set; the worker must be started from the same env file.
 */
export function requireSimulationEnv(env: Pick<Env, "PERIPLUS_SIMULATION" | "DATABASE_URL" | "S3_WRITE_PREFIX">, cli: string): SimulationSettings {
  const sim = assertSimulationEnv(env);
  if (!sim) {
    throw new SimulationTargetError(
      `${cli} läuft nur in einer Simulation: in der Umgebung dieses Aufrufs PERIPLUS_SIMULATION, DATABASE_URL auf ${SIMULATION_DATABASE} und S3_WRITE_PREFIX setzen (dieselbe Env-Datei wie der Sim-Worker).`,
    );
  }
  return sim;
}

/**
 * Start check of a CLI that calls paid services on its own (`compare:models`, `fixtures:record`, `smoke:ai`,
 * `consolidate`): never in a simulation (`PERIPLUS_SIMULATION`), never against the simulation clone and never with an
 * archive write prefix. Costs booked in the clone are dropped with it, so the real daily budget would never see them
 * (final review A M-5). Takes the raw environment: these CLIs do not need the full `Env`. German messages.
 */
export function refuseSimulationEnv(env: Record<string, string | undefined>, cli: string): void {
  if (env.PERIPLUS_SIMULATION) {
    throw new SimulationTargetError(`${cli} ruft bezahlte Dienste und läuft nie in einer Simulation: ohne PERIPLUS_SIMULATION starten (nicht mit .env.sim).`);
  }
  if (env.DATABASE_URL && databaseNameOrNull(env.DATABASE_URL) === SIMULATION_DATABASE) {
    throw new SimulationTargetError(
      `${cli} nicht gegen den Simulationsklon ${SIMULATION_DATABASE}: dort gebuchte Kosten sieht das echte Tagesbudget nie. DATABASE_URL auf die Entwicklungsdatenbank setzen.`,
    );
  }
  if (env.S3_WRITE_PREFIX) throw new SimulationTargetError("S3_WRITE_PREFIX gehört zu einer Simulation: ohne PERIPLUS_SIMULATION nicht setzen.");
}

/** The database name, or null when the URL does not parse (a non-simulation process then fails at connect, not here). */
function databaseNameOrNull(url: string): string | null {
  try {
    return databaseNameOf(url);
  } catch {
    return null;
  }
}
