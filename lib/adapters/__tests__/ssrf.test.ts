import { describe, expect, it } from "vitest";
import { isPublicAddress, isPublicHttpUrl, isPublicUrlLiteral } from "@/lib/adapters/fetch/ssrf";

const resolver = (table: Record<string, string[]>) => async (host: string) => {
  const addresses = table[host];
  if (!addresses) throw new Error(`ENOTFOUND ${host}`);
  return addresses;
};

describe("isPublicHttpUrl", () => {
  it("rejects private IP literals without resolving", async () => {
    const never = async () => {
      throw new Error("must not resolve");
    };
    for (const url of [
      "http://127.0.0.1/",
      "http://10.1.2.3/x",
      "https://172.20.0.1/",
      "http://192.168.1.1:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://2130706433/",
    ]) {
      expect(await isPublicHttpUrl(url, never), url).toBe(false);
    }
  });

  it("rejects a host name resolving to the cloud metadata address", async () => {
    expect(await isPublicHttpUrl("http://meta.example/", resolver({ "meta.example": ["169.254.169.254"] }))).toBe(false);
  });

  it("rejects a host when any of its addresses is private", async () => {
    const resolve = resolver({ "mixed.example": ["93.184.216.34", "10.0.0.5"] });
    expect(await isPublicHttpUrl("https://mixed.example/", resolve)).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 forms of private addresses", async () => {
    expect(await isPublicHttpUrl("http://[::ffff:10.0.0.1]/", resolver({}))).toBe(false);
    expect(await isPublicHttpUrl("http://mapped.example/", resolver({ "mapped.example": ["::ffff:10.0.0.1"] }))).toBe(false);
    expect(isPublicAddress("::ffff:a9fe:a9fe")).toBe(false);
    expect(isPublicAddress("0:0:0:0:0:ffff:7f00:1")).toBe(false);
  });

  it("allows a host with public addresses only", async () => {
    const resolve = resolver({ "boat.example": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] });
    expect(await isPublicHttpUrl("https://boat.example/a?b=1", resolve)).toBe(true);
    expect(await isPublicHttpUrl("http://8.8.8.8/", resolver({}))).toBe(true);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("rejects other schemes, unparsable URLs and hosts that do not resolve", async () => {
    const resolve = resolver({ "boat.example": ["93.184.216.34"] });
    expect(await isPublicHttpUrl("file:///etc/passwd", resolve)).toBe(false);
    expect(await isPublicHttpUrl("ftp://boat.example/", resolve)).toBe(false);
    expect(await isPublicHttpUrl("not a url", resolve)).toBe(false);
    expect(await isPublicHttpUrl("https://unknown.example/", resolve)).toBe(false);
  });
});

describe("isPublicUrlLiteral", () => {
  it("checks scheme, localhost and IP literals without DNS", () => {
    expect(isPublicUrlLiteral("https://boat.example/a")).toBe(true);
    expect(isPublicUrlLiteral("http://localhost:3000/")).toBe(false);
    expect(isPublicUrlLiteral("http://api.localhost/")).toBe(false);
    expect(isPublicUrlLiteral("http://169.254.169.254/")).toBe(false);
    expect(isPublicUrlLiteral("http://[::ffff:10.0.0.1]/")).toBe(false);
    expect(isPublicUrlLiteral("file:///etc/passwd")).toBe(false);
  });
});
