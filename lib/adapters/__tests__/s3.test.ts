import { describe, expect, it } from "vitest";
import { createArchive } from "@/lib/adapters/s3";
import { newId } from "@/lib/domain/ids";
import { testArchive, testArchiveOptions } from "@/test/s3";

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

  it("ping is true for the reachable bucket", async () => {
    await testArchive().ensureBucket();
    expect(await testArchive().ping()).toBe(true);
  });

  it("ping is false for a wrong endpoint without throwing", async () => {
    const archive = createArchive({ ...testArchiveOptions(), endpoint: "http://127.0.0.1:1" });
    expect(await archive.ping()).toBe(false);
  });
});
