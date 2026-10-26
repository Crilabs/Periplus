import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A rules version is frozen once a state carries it (`rules_version`, final review M-4): the content hash of every
 * state depends on its parameters, so an edit would rewrite states under the same label. v3 was trimmed once in N6
 * (the keys of the removed profile pipeline went; v1 and v2 went with it): the hash below is the trimmed file.
 */

const FROZEN: Record<string, string> = {
  "v3.json": "ba63ef0b2c3ceb46592fa9d014da0ed604f4af435495b704f391af7fcc38302f",
};

describe("frozen consolidation rules versions", () => {
  it.each(Object.entries(FROZEN))("config/consolidation/%s is unchanged", (file, sha256) => {
    const actual = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "config", "consolidation", file)))
      .digest("hex");
    expect(actual, `config/consolidation/${file} is frozen: create a new version instead of editing a frozen one`).toBe(sha256);
  });
});
