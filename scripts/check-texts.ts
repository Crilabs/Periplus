import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "../lib/config";
import { createDb, type Db } from "../lib/db/client";
import { fidelityShare } from "../lib/domain/extraction/fidelity";
import { measureTileBorders, type TileBorderMeasurement } from "../lib/domain/mentions/tile-borders";
import { MODEL_COMPARISON_SCOPE } from "../lib/pipeline/text/run";

/** Roadmap/spec 06 acceptance: more than this share of mentions without a model call. */
export const MIN_DETERMINISTIC_SHARE = 0.7;

export type TextStats = {
  /** Text facts and route stops checked by the extraction runs' quote checks (unchecked runs: by their stored flag). */
  belegtreue: { facts: number; verified: number };
  blockedRuns: number;
  mentions: number;
  deterministicMentions: number;
  /** Anthropic cost of the text runs (model comparison runs left out). */
  anthropicEur: number;
  routes: { routes: number; complete: number; openStops: number };
  tileBorders: TileBorderMeasurement;
};

export type TextsCheck = {
  belegtreue: { facts: number; verified: number; ratio: number };
  blockedRuns: number;
  modelDecision: "provisional" | "decided";
  costPerMentionEur: number | null;
  deterministicShare: number;
  mentions: number;
  routes: { routes: number; complete: number; openStops: number };
  tileBorders: TileBorderMeasurement;
};

/** The check's verdicts on the collected numbers (pure; the configuration supplies the model decision). */
export function assessTexts(stats: TextStats, cfg: Pick<AppConfig, "models"> = getConfig()): TextsCheck {
  const { facts, verified } = stats.belegtreue;
  return {
    belegtreue: { facts, verified, ratio: fidelityShare(verified, facts) },
    blockedRuns: stats.blockedRuns,
    modelDecision: cfg.models.tasks["extract-facts"]?.decision?.status ?? "provisional",
    costPerMentionEur: stats.mentions > 0 ? Number((stats.anthropicEur / stats.mentions).toFixed(6)) : null,
    deterministicShare: stats.mentions > 0 ? Number((stats.deterministicMentions / stats.mentions).toFixed(4)) : 0,
    mentions: stats.mentions,
    routes: stats.routes,
    tileBorders: stats.tileBorders,
  };
}

/** Why the check fails (empty: it passes). */
export function textCheckFailures(check: TextsCheck): string[] {
  const failures: string[] = [];
  if (check.belegtreue.verified < check.belegtreue.facts) {
    failures.push(`Belegtreue ${(check.belegtreue.ratio * 100).toFixed(2)} % (${check.belegtreue.verified} of ${check.belegtreue.facts}) below 100 %`);
  }
  if (check.blockedRuns > 0) failures.push(`${check.blockedRuns} blocked extraction run(s): check them on their run page`);
  if (check.modelDecision === "provisional") failures.push("extraction model decision is provisional (config/models.json tasks.extract-facts.decision.status)");
  if (check.deterministicShare <= MIN_DETERMINISTIC_SHARE) {
    failures.push(`share of mentions without a model call ${(check.deterministicShare * 100).toFixed(1)} % not above ${MIN_DETERMINISTIC_SHARE * 100} %`);
  }
  return failures;
}

/** The numbers of the check, from the whole database (`DATABASE_URL`). */
export async function textStats(db: Db, cfg: AppConfig = getConfig()): Promise<TextStats> {
  const { rows } = await db.execute<{
    facts: number;
    verified: number;
    blocked: number;
    mentions: number;
    deterministic: number;
    anthropic_eur: number;
    routes: number;
    complete: number;
    open_stops: number;
  }>(sql`
    select
      (select coalesce(sum(n.facts), 0)::int from extraction_runs r cross join lateral (
        select (r.quote_check ->> 'facts')::int as facts where r.quote_check is not null
        union all select count(*)::int from facts f where r.quote_check is null and f.extraction_run_id = r.id and f.mention_id is not null
      ) n) as facts,
      (select coalesce(sum(n.verified), 0)::int from extraction_runs r cross join lateral (
        select (r.quote_check ->> 'verified')::int as verified where r.quote_check is not null
        union all select count(*) filter (where f.quote_verified)::int from facts f where r.quote_check is null and f.extraction_run_id = r.id and f.mention_id is not null
      ) n) as verified,
      (select count(*)::int from extraction_runs where status = 'blocked') as blocked,
      (select count(*)::int from mentions) as mentions,
      (select count(*)::int from mentions where match_kind = 'deterministic') as deterministic,
      (select coalesce(sum(e.cost_eur), 0)::float8 from external_calls e join runs ru on ru.id = e.run_id
        where e.service = 'anthropic' and ru.scope_id <> ${MODEL_COMPARISON_SCOPE}
          and ('mentions.batch' = any(ru.stages) or 'extraction.mention' = any(ru.stages))) as anthropic_eur,
      (select count(*)::int from routes) as routes,
      (select count(*)::int from routes ro where not exists (select 1 from route_stops s where s.route_id = ro.id and s.geo_object_id is null)) as complete,
      (select count(*)::int from route_stops where geo_object_id is null) as open_stops
  `);
  const r = rows[0]!;
  return {
    belegtreue: { facts: Number(r.facts), verified: Number(r.verified) },
    blockedRuns: Number(r.blocked),
    mentions: Number(r.mentions),
    deterministicMentions: Number(r.deterministic),
    anthropicEur: Number(r.anthropic_eur),
    routes: { routes: Number(r.routes), complete: Number(r.complete), openStops: Number(r.open_stops) },
    tileBorders: await measureTileBorders(db, cfg),
  };
}

/** M4 acceptance check of the texts (spec 06, roadmap): `textStats` assessed by `assessTexts`. */
export async function checkTexts(db: Db, cfg: AppConfig = getConfig()): Promise<TextsCheck> {
  return assessTexts(await textStats(db, cfg), cfg);
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error("usage: check-texts.ts");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    const r = await checkTexts(db);
    out(`Belegtreue: ${(r.belegtreue.ratio * 100).toFixed(2)} % (${r.belegtreue.verified} of ${r.belegtreue.facts} facts and route stops)`);
    out(`blocked extraction runs: ${r.blockedRuns}`);
    out(`extraction model decision: ${r.modelDecision} (${getConfig().models.tasks["extract-facts"]?.model})`);
    out(`mentions: ${r.mentions}, without a model call: ${(r.deterministicShare * 100).toFixed(1)} % (target > ${MIN_DETERMINISTIC_SHARE * 100} %)`);
    out(`cost per mention: ${r.costPerMentionEur === null ? "–" : `${r.costPerMentionEur.toFixed(6)} EUR`} (anthropic, text runs)`);
    out(`routes: ${r.routes.routes}, all stops assigned: ${r.routes.complete}, open stops: ${r.routes.openStops}`);
    out(`tile borders (unmatched names, last 30 days): ${r.tileBorders.unmatchedNames}, found with neighbourRing 2: ${r.tileBorders.matchedWithRing2}`);
    const failures = textCheckFailures(r);
    for (const f of failures) out(`FAIL: ${f}`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
