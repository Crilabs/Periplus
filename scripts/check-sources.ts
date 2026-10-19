import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "../lib/config";
import { createDb, type Db } from "../lib/db/client";

/** Spec 05 acceptance: 20–40 approved sources. */
export const APPROVED_RANGE = { min: 20, max: 40 } as const;

export type SourceStats = {
  approved: number;
  perSource: Array<{ domain: string; documents: number; versions: number; queued: number; failed: number; costEur: number }>;
  openFailedFetchJobs: number;
};

export type SourcesCheck = SourceStats & {
  inRange: boolean;
  converterDecision: "provisional" | "decided";
  pdfExtractor: string;
};

/** The check's verdicts on the collected numbers (pure; the configuration supplies the decisions). */
export function assessSources(stats: SourceStats, cfg: Pick<AppConfig, "fetch"> = getConfig()): SourcesCheck {
  return {
    approved: stats.approved,
    inRange: stats.approved >= APPROVED_RANGE.min && stats.approved <= APPROVED_RANGE.max,
    perSource: stats.perSource,
    openFailedFetchJobs: stats.openFailedFetchJobs,
    converterDecision: cfg.fetch.decision.status,
    pdfExtractor: cfg.fetch.pdf.extractor,
  };
}

/** Why the check fails (empty: it passes). */
export function checkFailures(check: SourcesCheck): string[] {
  const failures: string[] = [];
  if (!check.inRange) failures.push(`approved sources ${check.approved} outside ${APPROVED_RANGE.min}–${APPROVED_RANGE.max}`);
  if (check.openFailedFetchJobs > 0) failures.push(`${check.openFailedFetchJobs} open failed fetch/embed jobs in /review`);
  if (check.converterDecision === "provisional") failures.push("converter decision is provisional (config/fetch.json decision.status)");
  return failures;
}

/**
 * M3 acceptance check of the sources: the current approved sources with their documents, versions, queued and
 * failed frontier rows and costs (`external_calls.source_id`, all time), and the open `failed_job` review tasks of
 * the queues `fetch.*` and `embed.chunks`.
 */
export async function checkSources(db: Db, cfg: Pick<AppConfig, "fetch"> = getConfig()): Promise<SourcesCheck> {
  const { rows } = await db.execute<{ domain: string; documents: number; versions: number; queued: number; failed: number; cost_eur: string }>(sql`
    select s.domain,
      (select count(*)::int from documents d where d.source_id = s.id) as documents,
      (select count(*)::int from document_versions v join documents d on d.id = v.document_id where d.source_id = s.id) as versions,
      (select count(*)::int from crawl_frontier f where f.source_id = s.id and f.status = 'queued') as queued,
      (select count(*)::int from crawl_frontier f where f.source_id = s.id and f.status = 'failed') as failed,
      (select coalesce(sum(e.cost_eur), 0) from external_calls e where e.source_id = s.id) as cost_eur
    from sources s
    where s.status = 'approved' and s.valid_to is null
    order by s.domain
  `);
  const { rows: jobs } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from review_tasks
    where kind = 'failed_job' and status = 'open'
      and (context ->> 'queue' like 'fetch.%' or context ->> 'queue' = 'embed.chunks')
  `);
  return assessSources(
    {
      approved: rows.length,
      perSource: rows.map((r) => ({
        domain: r.domain,
        documents: r.documents,
        versions: r.versions,
        queued: r.queued,
        failed: r.failed,
        costEur: Number(r.cost_eur),
      })),
      openFailedFetchJobs: jobs[0]?.n ?? 0,
    },
    cfg,
  );
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error("usage: check-sources.ts");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    const r = await checkSources(db);
    process.stdout.write(`approved sources: ${r.approved} (${r.inRange ? "in" : "outside"} ${APPROVED_RANGE.min}–${APPROVED_RANGE.max})\n`);
    process.stdout.write("domain\tdocuments\tversions\tqueued\tfailed\tcost EUR\n");
    for (const s of r.perSource) {
      process.stdout.write(`${s.domain}\t${s.documents}\t${s.versions}\t${s.queued}\t${s.failed}\t${s.costEur.toFixed(4)}\n`);
    }
    process.stdout.write(`open failed fetch/embed jobs: ${r.openFailedFetchJobs}\n`);
    process.stdout.write(`converter decision: ${r.converterDecision}\n`);
    process.stdout.write(`pdf extractor: ${r.pdfExtractor}\n`);
    const failures = checkFailures(r);
    for (const f of failures) process.stdout.write(`FAIL: ${f}\n`);
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
