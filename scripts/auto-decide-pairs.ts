import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../lib/config";
import { createDb } from "../lib/db/client";
import { AUTO_DECIDER, autoDecideOpenPairTasks } from "../lib/domain/gazetteer/merge";
import { refuseSimulationEnv } from "../lib/domain/revisit/guard";
import { createBoss } from "../lib/jobs/boss";
import { ensureQueues } from "../lib/jobs/queues";
import { consolidateAfter } from "../lib/pipeline/follow-ups";

/*
 * Decides the open pair tasks („Dasselbe Objekt?“) that the rule `autoPairDecision` knows the answer to, once for the
 * tasks opened before the rule existed; new pairs are decided when they are found. Then consolidates the objects that
 * kept a merged object, as a decision in the review does.
 */

async function main(): Promise<void> {
  refuseSimulationEnv(process.env, "auto-decide-pairs");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const config = getConfig();
  const { db, close } = createDb(url);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  try {
    const result = await autoDecideOpenPairTasks(db, config.gazetteer.merge);
    out(`same: ${result.same}, distinct: ${result.distinct}, dismissed: ${result.dismissed}, left open: ${result.open}`);
    if (result.kept.length === 0) return;
    const boss = createBoss(url, { supervise: false, schedule: false });
    await boss.start();
    try {
      await ensureQueues(boss, config.queues);
      const run = await consolidateAfter(db, async () => boss, { geoObjectIds: result.kept, triggeredBy: AUTO_DECIDER });
      out(`consolidation of ${result.kept.length} objects: ${JSON.stringify(run)}`);
    } finally {
      await boss.stop({ graceful: true });
    }
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
