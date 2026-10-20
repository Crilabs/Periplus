import { sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { spotAsOf } from "@/lib/domain/delivery/read";
import { loadScenario, type RevisitScenario } from "./scenario";
import { asOfPlan, checkAsOf, checkCurrentSpot, readSimMeta, verifyRevisit, type AsOfCheck, type RevisitVerification } from "./verify";

/*
 * The verification of a simulated revisit behind `sim:verify` (spec 10, plan Task 13; moved out of the CLI, final
 * review B M-6): the change feed of the clone against the scenario and, against the simulation web, the asOf check.
 * The API key is never returned or written.
 */

export type SimVerifyInput = { area: string; scenario: string; baseUrl?: string; key?: string; spot?: string };

export type AsOfReport =
  | { ok: false; reason: string }
  | { ok: boolean; asOf: string; spot: string; before: { dataVersion: number }; after: { dataVersion: number }; check: AsOfCheck };

export type SimVerifyReport = {
  area: string;
  scenario: string;
  clonedAt: string;
  fromSeq: number;
  verification: RevisitVerification;
  asOf: AsOfReport | null;
  /** External calls of the simulation database since the clone (ruling M7-P15: reported apart from the pilot runs). */
  costs: { totalEur: number; byService: Record<string, { calls: number; eur: number }> };
  passes: boolean;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The asOf check talks to the simulation web only, which runs locally from its own worktree (run book): a base URL
 * with another host (a deployed web) is refused before any request (final review A M-4). German message.
 */
export function assertSimulationWebUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`--base-url ${baseUrl} ist keine gültige URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`--base-url nur gegen das lokale Simulations-Web (localhost, z. B. http://localhost:3001), nicht ${url.host || baseUrl}`);
  }
}

/** The first `sp_` subject of an expectation the verification matched (ruling M7-P18), else null. */
export function changedSpot(scenario: RevisitScenario, v: RevisitVerification): string | null {
  for (const entry of scenario.entries) {
    const result = v.entries.find((e) => e.id === entry.id);
    if (!result || result.events.matched === 0) continue;
    const spot = entry.expect.events.find((e) => e.subject.startsWith("sp_"));
    if (spot) return spot.subject;
  }
  return null;
}

/**
 * The asOf check (ruling M7-P18, M7-G-R3): the spot of `spot` or the first changed one; it must have been delivered
 * before the revisit by a package before it and changed in the revisit. The web must first answer the spot's newest
 * state of the clone (`checkCurrentSpot`: only the simulation web has the package built after the revisit, final review
 * A M-4), then the old state for `asOf`.
 */
export async function asOfReport(
  db: Db,
  archive: Archive,
  input: { area: string; baseUrl: string; key: string; spot?: string },
  scenario: RevisitScenario,
  v: RevisitVerification,
  doFetch?: typeof fetch,
): Promise<AsOfReport> {
  const plan = await asOfPlan(db, input.area);
  if ("reason" in plan) return { ok: false, reason: plan.reason };
  const spot = input.spot ?? changedSpot(scenario, v);
  if (!spot) return { ok: false, reason: "Kein Spot mit erkannter Änderung – --spot angeben" };
  const before = await spotAsOf(db, archive, spot, plan.asOf);
  if (!before) return { ok: false, reason: `Spot ${spot} war am ${plan.asOf} nicht geliefert` };
  // the expectation is bound to the plan: the spot as a package before the revisit delivered it (ruling M7-G-R3)
  if (before.dataVersion > plan.before.dataVersion) return { ok: false, reason: `asOf ${plan.asOf} liefert für ${spot} einen Stand nach dem Revisit` };
  const after = await spotAsOf(db, archive, spot);
  if (!after || after.dataVersion === before.dataVersion) return { ok: false, reason: `Spot ${spot} hat sich im Revisit nicht geändert` };
  const current = await checkCurrentSpot({
    baseUrl: input.baseUrl,
    key: input.key,
    spotId: spot,
    expectCurrent: { dataVersion: after.dataVersion, spot: after.spot },
    fetch: doFetch,
  });
  if (!current.ok) {
    return {
      ok: false,
      reason: `${input.baseUrl} ist nicht das Simulations-Web (${current.reason ?? `HTTP ${current.status}`}) – das Web aus dem eigenen Worktree mit .env.sim starten`,
    };
  }
  const check = await checkAsOf({
    baseUrl: input.baseUrl,
    key: input.key,
    spotId: spot,
    asOf: plan.asOf,
    expectBefore: { dataVersion: before.dataVersion, spot: before.spot },
    fetch: doFetch,
  });
  return { ok: check.ok, asOf: plan.asOf, spot, before: { dataVersion: before.dataVersion }, after: { dataVersion: after.dataVersion }, check };
}

async function simCosts(db: Db, since: Date): Promise<SimVerifyReport["costs"]> {
  const { rows } = await db.execute<{ service: string; calls: number; eur: string }>(sql`
    select service, count(*)::int as calls, coalesce(sum(cost_eur), 0)::text as eur
    from external_calls where at >= ${since.toISOString()}::timestamptz group by service order by service
  `);
  const byService = Object.fromEntries(rows.map((r) => [r.service, { calls: Number(r.calls), eur: Number(r.eur) }]));
  return { totalEur: rows.reduce((sum, r) => sum + Number(r.eur), 0), byService };
}

/**
 * The verification of a simulated revisit: `sim_meta` (else refused: no simulation clone), refused while a revisit run
 * of the area is queued or running, `verifyRevisit` from its `from_seq`, with `baseUrl` (local only,
 * `assertSimulationWebUrl`) the asOf check (`asOfReport`), the clone's external costs. Passes when the verification
 * passes and the asOf check, if asked for, is ok.
 */
export async function simVerify(
  db: Db,
  archive: Archive,
  input: SimVerifyInput,
  opts: { fetch?: typeof fetch; scenario?: RevisitScenario } = {},
): Promise<SimVerifyReport> {
  if (input.baseUrl !== undefined) assertSimulationWebUrl(input.baseUrl);
  const meta = await readSimMeta(db);
  if (!meta) throw new Error("keine Sim-Datenbank – scripts/sim/clone.sh");
  // a revisit still at work writes more events: a pass now could be premature (ruling M7-G-R3)
  const { rows: live } = await db.execute<{ id: string }>(sql`
    select id from runs where kind = 'revisit' and scope_type = 'area' and scope_id = ${input.area} and status in ('queued', 'running')
    order by created_at limit 1
  `);
  if (live[0]) throw new Error(`Revisit-Lauf ${live[0].id} läuft noch – erst abwarten (/runs)`);
  const scenario = opts.scenario ?? (await loadScenario(input.scenario));
  const verification = await verifyRevisit(db, scenario, { fromSeq: meta.fromSeq, areaKey: input.area });
  const asOf =
    input.baseUrl !== undefined && input.key !== undefined
      ? await asOfReport(db, archive, { area: input.area, baseUrl: input.baseUrl, key: input.key, spot: input.spot }, scenario, verification, opts.fetch)
      : null;
  return {
    area: input.area,
    scenario: scenario.name,
    clonedAt: meta.clonedAt.toISOString(),
    fromSeq: meta.fromSeq,
    verification,
    asOf,
    costs: await simCosts(db, meta.clonedAt),
    passes: verification.passes && (asOf === null || asOf.ok),
  };
}
