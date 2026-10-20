import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { checkTexts, textCheckFailures } from "../lib/domain/acceptance/texts";

// The check itself lives in lib/domain (gesamt review UI-16); this file is its command line.

export * from "../lib/domain/acceptance/texts";

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
    // Assigned to any geo object; the quality metric route_reconstruction (/quality) counts a stop only at a confirmed
    // place, so its numbers differ until the places are reviewed (OPS-8).
    out(`routes: ${r.routes.routes}, all stops assigned to an object: ${r.routes.complete}, stops without an object: ${r.routes.openStops} (not the quality metric route_reconstruction, which needs confirmed places)`);
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
