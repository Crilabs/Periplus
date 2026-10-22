import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A rules version is frozen once profiles carry it (`rules_version`, final review M-4): the content hash of every
 * profile depends on its parameters, so an edit would rewrite profiles under the same label.
 */

const FROZEN: Record<string, string> = {
  "v1.json": "420e24807c48a83b906f05aa23251163a2a76490441244ac0b3a6689bda80d5b",
  "v2.json": "bb6e91f76ed24d09977478ab635e7e841b1a77eb99837d042d0107d350b23b92",
  "v3.json": "5bf56b5b02014a2744d6df991a5be08c3772b8b56b58b90df306fec99cae8efd",
};

describe("frozen consolidation rules versions", () => {
  it.each(Object.entries(FROZEN))("config/consolidation/%s is unchanged", (file, sha256) => {
    const actual = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "config", "consolidation", file)))
      .digest("hex");
    expect(actual, `config/consolidation/${file} is frozen: create a new version instead of editing a frozen one`).toBe(sha256);
  });
});
