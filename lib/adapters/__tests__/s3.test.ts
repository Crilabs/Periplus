import { describe, expect, it } from "vitest";
import { createArchive } from "@/lib/adapters/s3";
import { newId } from "@/lib/domain/ids";
import { deleteTestObjects, testArchive, testArchiveOptions } from "@/test/s3";

describe("s3 archive", () => {
  it("ensureBucket is idempotent", async () => {
    await testArchive().ensureBucket();
    await testArchive().ensureBucket();
  });

  it("put then get returns the same bytes", async () => {
    await testArchive().ensureBucket();
    const key = `t/${newId()}.md`;
    await testArchive().put(key, "# Ägina", "text/markdown");
    expect(new TextDecoder().decode((await testArchive().get(key))!)).toBe("# Ägina");
    expect(await testArchive().exists(key)).toBe(true);
  });

  it("get of a missing key returns null, exists returns false", async () => {
    await testArchive().ensureBucket();
    const key = `t/${newId()}-missing.md`;
    expect(await testArchive().get(key)).toBeNull();
    expect(await testArchive().exists(key)).toBe(false);
  });

  it("writes go under the prefix, reads fall back to the unprefixed key", async () => {
    await testArchive().ensureBucket();
    const run = newId();
    const prefix = `sim/${run}/`;
    const x = `t/${run}/a/x`;
    const y = `t/${run}/a/y`;
    const sim = createArchive({ ...testArchiveOptions(), writePrefix: prefix });
    try {
      await testArchive().put(x, "recorded", "text/plain");
      // The recorded object is visible through the prefixed archive.
      expect(new TextDecoder().decode((await sim.get(x))!)).toBe("recorded");
      expect(await sim.exists(x)).toBe(true);

      await sim.put(y, "simulated", "text/plain");
      expect(await testArchive().exists(`${prefix}${y}`)).toBe(true);
      expect(await testArchive().exists(y)).toBe(false);
      expect(new TextDecoder().decode((await sim.get(y))!)).toBe("simulated");

      // A prefixed write shadows the recorded object of the same key; the recorded one stays untouched.
      await sim.put(x, "edited", "text/plain");
      expect(new TextDecoder().decode((await sim.get(x))!)).toBe("edited");
      expect(new TextDecoder().decode((await testArchive().get(x))!)).toBe("recorded");
      expect(await sim.get(`t/${run}/a/missing`)).toBeNull();
      expect(await sim.exists(`t/${run}/a/missing`)).toBe(false);
    } finally {
      await deleteTestObjects([x, `${prefix}${x}`, `${prefix}${y}`]);
    }
  });

  it("refuses a malformed write prefix", () => {
    for (const writePrefix of ["sim", "/sim/", "Sim/"]) {
      expect(() => createArchive({ ...testArchiveOptions(), writePrefix })).toThrow(/write prefix/);
    }
  });

  it("ping is true for the reachable bucket", async () => {
    await testArchive().ensureBucket();
    expect(await testArchive().ping()).toBe(true);
  });

  it("ping is false for a wrong endpoint without throwing", async () => {
    const archive = createArchive({ ...testArchiveOptions(), endpoint: "http://127.0.0.1:1" });
    expect(await archive.ping()).toBe(false);
  });
});
