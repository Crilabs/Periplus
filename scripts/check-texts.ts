import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "../lib/config";
import { createDb, type Db } from "../lib/db/client";
import { belegtreue, fidelityShare } from "../lib/domain/extraction/fidelity";
import { measureTileBorders, type TileBorderMeasurement } from "../lib/domain/mentions/tile-borders";
import { MODEL_COMPARISON_SCOPE } from "../lib/pipeline/text/run";

export type TextStats = {
  /** Text facts and route stops checked by the extraction runs' quote checks (unchecked runs: by their stored flag). */
  belegtreue: { facts: number; verified: number };
  blockedRuns: number;
  /**
   * Mentions of the name match (deterministic, or chosen by the disambiguation of an ambiguous span); the POI mentions
   * the fact extraction creates are left out (they come from the extraction, not from the match).
   */
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
  /** The share the acceptance requires to be exceeded (`extraction.acceptance.minDeterministicShare`). */
  minDeterministicShare: number;
  mentions: number;
  routes: { routes: number; complete: number; openStops: number };
  tileBorders: TileBorderMeasurement;
};

/** The check's verdicts on the collected numbers (pure; the configuration supplies the model decision and threshold). */
export function assessTexts(stats: TextStats, cfg: Pick<AppConfig, "models" | "extraction"> = getConfig()): TextsCheck {
  const { facts, verified } = stats.belegtreue;
  return {
    belegtreue: { facts, verified, ratio: fidelityShare(verified, facts) },
    blockedRuns: stats.blockedRuns,
    modelDecision: cfg.models.tasks["extract-facts"]?.decision?.status ?? "provisional",
    costPerMentionEur: stats.mentions > 0 ? Number((stats.anthropicEur / stats.mentions).toFixed(6)) : null,
    deterministicShare: stats.mentions > 0 ? Number((stats.deterministicMentions / stats.mentions).toFixed(4)) : 0,
    minDeterministicShare: cfg.extraction.acceptance.minDeterministicShare,
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
  if (check.deterministicShare <= check.minDeterministicShare) {
    failures.push(`share of mentions without a model call ${(check.deterministicShare * 100).toFixed(1)} % not above ${check.minDeterministicShare * 100} %`);
  }
  return failures;
}

/**
 * Mentions of the name match and those without a model call (`TextStats`), of the whole database or (tests) of the
 * given versions only.
 */
export async function matchMentionCounts(db: Db, scope?: { versionIds: string[] }): Promise<{ mentions: number; deterministic: number }> {
  const where = scope ? sql`m.document_version_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(scope.versionIds)}::jsonb))` : sql`true`;
  const { rows } = await db.execute<{ mentions: number; deterministic: number }>(sql`
    select
      count(*) filter (where m.match_kind = 'deterministic' or exists (
        select 1 from ambiguous_matches am where am.chunk_id = m.chunk_id and am.char_start = m.char_start and am.char_end = m.char_end
      ))::int as mentions,
      count(*) filter (where m.match_kind = 'deterministic')::int as deterministic
    from mentions m
    where ${where}
  `);
  return { mentions: Number(rows[0]!.mentions), deterministic: Number(rows[0]!.deterministic) };
}

/** The numbers of the check, from the whole database (`DATABASE_URL`). */
export async function textStats(db: Db, cfg: AppConfig = getConfig()): Promise<TextStats> {
  const { rows } = await db.execute<{
    blocked: number;
    anthropic_eur: number;
    routes: number;
    complete: number;
    open_stops: number;
  }>(sql`
    select
      (select count(*)::int from extraction_runs where status = 'blocked') as blocked,
      (select coalesce(sum(e.cost_eur), 0)::float8 from external_calls e join runs ru on ru.id = e.run_id
        where e.service = 'anthropic' and ru.scope_id <> ${MODEL_COMPARISON_SCOPE}
          and ('mentions.batch' = any(ru.stages) or 'extraction.mention' = any(ru.stages))) as anthropic_eur,
      (select count(*)::int from routes) as routes,
      (select count(*)::int from routes ro where not exists (select 1 from route_stops s where s.route_id = ro.id and s.geo_object_id is null)) as complete,
      (select count(*)::int from route_stops where geo_object_id is null) as open_stops
  `);
  const r = rows[0]!;
  const fidelity = await belegtreue(db, null);
  const matched = await matchMentionCounts(db);
  return {
    belegtreue: { facts: fidelity.facts, verified: fidelity.verified },
    blockedRuns: Number(r.blocked),
    mentions: matched.mentions,
    deterministicMentions: matched.deterministic,
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
    out(`mentions of the name match: ${r.mentions}, without a model call: ${(r.deterministicShare * 100).toFixed(1)} % (target > ${r.minDeterministicShare * 100} %)`);
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
