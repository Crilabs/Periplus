import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../lib/db/client";
import { APPROVED_RANGE, checkFailures, checkSources } from "../lib/domain/acceptance/sources";

// The check itself lives in lib/domain (gesamt review UI-16); this file is its command line.

export * from "../lib/domain/acceptance/sources";

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
    process.stdout.write(`approved sources without documents: ${r.withoutDocuments.length}\n`);
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
