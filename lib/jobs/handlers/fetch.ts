import { createConverters, type RenderPage } from "@/lib/adapters/fetch";
import { getRenderer } from "@/lib/adapters/fetch/browser";
import { createSimulatedFetcher, simulatedTransport, type SimulatedFetcher } from "@/lib/adapters/fetch/simulated";
import { runPdftotext } from "@/lib/adapters/pdf";
import type { getConfig } from "@/lib/config";
import { parseScenario, readScenarioFile } from "@/lib/domain/revisit/scenario";
import { getEnv, type Env } from "@/lib/env";

/** The page renderer of this process: Playwright unless `PERIPLUS_RENDERER=off` (then `render: auto` never renders). */
export function crawlRenderPage(env: Pick<Env, "PERIPLUS_RENDERER"> = getEnv()): RenderPage | undefined {
  return env.PERIPLUS_RENDERER === "off" ? undefined : getRenderer().render;
}

let scenarioCache: { path: string; hash: string; fetcher: SimulatedFetcher } | undefined;

/** What `simulatedFetcherFor` reports when it (re)loads a scenario. */
export type ScenarioLoaded = { path: string; name: string; hash: string };

/**
 * The simulated web of a process with `PERIPLUS_SIMULATION`, else null. The scenario is cached by path and content
 * hash: each job reads the file, and an edited file (e.g. an entry added between two `sim:revisit` calls while the
 * worker keeps running) is validated and used at once instead of the old one (`onLoad` names it). A failed load is
 * not kept: the job fails and the next one reads the file again.
 */
export async function simulatedFetcherFor(
  env: Pick<Env, "PERIPLUS_SIMULATION"> = getEnv(),
  onLoad?: (loaded: ScenarioLoaded) => void,
): Promise<SimulatedFetcher | null> {
  const path = env.PERIPLUS_SIMULATION;
  if (!path) return null;
  const { hash, text } = await readScenarioFile(path);
  if (scenarioCache?.path === path && scenarioCache.hash === hash) return scenarioCache.fetcher;
  const scenario = parseScenario(text, path);
  scenarioCache = { path, hash, fetcher: createSimulatedFetcher(scenario) };
  onLoad?.({ path, name: scenario.name, hash });
  return scenarioCache.fetcher;
}

/**
 * The fetch dependencies of a simulation (ruling M7-P8): every page from the scenario's fetcher, the simulated
 * transport for robots.txt and the converters, no converter service, renderer or model. Shared with the revisit
 * integration test, so it drives exactly this wiring (ruling M7-G-R3).
 */
export function simulatedFetchDeps(simulated: SimulatedFetcher, cfg: ReturnType<typeof getConfig>["fetch"]) {
  return {
    transport: simulatedTransport,
    converters: createConverters({ transport: simulatedTransport, cfg }),
    pdf: { pdftotext: runPdftotext },
    simulated,
  };
}
