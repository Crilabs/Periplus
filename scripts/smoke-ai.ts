import { createDb } from "../lib/db/client";
import { refuseSimulationEnv } from "../lib/domain/revisit/guard";
import { createAnthropicClient } from "../lib/ai/anthropic";
import { echoTask } from "../lib/ai/tasks/system-echo";

async function main(): Promise<void> {
  // never in a simulation or on its clone: costs booked there escape the real budget (final review A M-5)
  refuseSimulationEnv(process.env, "smoke:ai");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (put it in .env.local)");
  const { db, close } = createDb(url);
  try {
    const result = await createAnthropicClient(db).call(echoTask, { text: "Guten Morgen, Periplus!" }, { stage: "smoke" });
    process.stdout.write(`${JSON.stringify(result.output)}\nmodel=${result.model} tokens=${result.usage.inputTokens}+${result.usage.outputTokens} cost=${result.costEur.toFixed(6)} EUR\n`);
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`smoke:ai failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
