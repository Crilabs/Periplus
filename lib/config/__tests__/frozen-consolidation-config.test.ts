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
  "v2.json": "67beb6650989f86186f4fec8d9761d4417af3bb93f43781d2475c1bf40eb3066",
};

describe("frozen consolidation rules versions", () => {
  it.each(Object.entries(FROZEN))("config/consolidation/%s is unchanged", (file, sha256) => {
    const actual = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "config", "consolidation", file)))
      .digest("hex");
    expect(actual, `config/consolidation/${file} is frozen: create v2 instead of editing v1`).toBe(sha256);
  });
});
