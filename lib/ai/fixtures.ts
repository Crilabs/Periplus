import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "@/lib/domain/facts/schema";

/**
 * Recorded model answers for tests (`test/fixtures/ai/<task>/<key>.json`). Kept out of `./mock`'s callers in the app:
 * only tests and scripts read fixtures from disk.
 */

const DEFAULT_FIXTURE_DIR = "test/fixtures/ai";

const fixtureFileSchema = z.object({
  task: z.string().min(1),
  key: z.string().regex(/^[0-9a-f]{64}$/),
  input: z.unknown(),
  output: z.unknown(),
  model: z.string().min(1),
  recordedAt: z.string().min(1),
});

export type AiFixture = z.infer<typeof fixtureFileSchema>;

/** sha256 hex of the canonical JSON of `{ task, input }`: the same input gives the same key in any key order. */
export function fixtureKey(taskName: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ task: taskName, input })).digest("hex");
}

/**
 * Reads every recorded answer below `dir` into one responder per task, as `MockModel` takes them. A responder
 * throws for an input nobody recorded, so a test never silently gets an answer to another question.
 */
export function loadAiFixtures(dir = DEFAULT_FIXTURE_DIR): Record<string, (input: unknown) => unknown> {
  const byTask = new Map<string, Map<string, unknown>>();
  if (existsSync(dir)) {
    for (const taskDir of readdirSync(dir, { withFileTypes: true })) {
      if (!taskDir.isDirectory()) continue;
      for (const file of readdirSync(join(dir, taskDir.name))) {
        if (!file.endsWith(".json")) continue;
        const path = join(dir, taskDir.name, file);
        const fixture = fixtureFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        if (fixture.task !== taskDir.name || `${fixture.key}.json` !== file) {
          throw new Error(`AI fixture ${path} does not match its task directory or file name`);
        }
        if (fixtureKey(fixture.task, fixture.input) !== fixture.key) throw new Error(`AI fixture ${path} has a stale key`);
        let answers = byTask.get(fixture.task);
        if (!answers) byTask.set(fixture.task, (answers = new Map()));
        answers.set(fixture.key, fixture.output);
      }
    }
  }
  return Object.fromEntries(
    [...byTask].map(([task, answers]) => [
      task,
      (input: unknown) => {
        const key = fixtureKey(task, input);
        if (!answers.has(key)) throw new Error(`No recorded answer for task ${task} and this input (key ${key})`);
        return answers.get(key);
      },
    ]),
  );
}
