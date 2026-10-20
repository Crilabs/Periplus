import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * Server commands in the run books (OPS-1): compose against the production file only with the server's `.env`
 * (the `dc` alias), and scripts only in the worker container — the web image is the standalone server without
 * `scripts/`, tsx or npm scripts.
 */

const files = ["docs/runbook.md", ...readdirSync("docs/pilot").filter((f) => f.endsWith(".md")).map((f) => `docs/pilot/${f}`)];
const lines = files.flatMap((file) => readFileSync(file, "utf8").split("\n").map((text, i) => ({ at: `${file}:${i + 1}`, text })));

describe("run book server commands", () => {
  it("compose with the production file always gets the server's env file", () => {
    const bad = lines.filter((l) => /docker compose[^`\n]*compose\.prod\.yml/.test(l.text) && !/--env-file/.test(l.text));
    expect(bad.map((l) => l.at)).toEqual([]);
  });

  it("no bare `docker compose run` (without a compose file) and no script run in the web container", () => {
    const bare = lines.filter((l) => /docker compose (run|exec)\b/.test(l.text));
    const web = lines.filter((l) => /\b(dc|docker compose[^`\n]*) (run|exec)\b[^`\n]*\bweb (npm|node|npx)\b/.test(l.text));
    expect([...bare, ...web].map((l) => l.at)).toEqual([]);
  });
});
