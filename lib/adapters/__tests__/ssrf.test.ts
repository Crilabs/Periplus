import { afterAll, describe, expect, it } from "vitest";
import { BlockedAddressError, createGuardedAgent, createGuardedTransport } from "@/lib/adapters/fetch/guarded";
import { BlockedUrlError, isPublicAddress, isPublicHttpUrl, isPublicUrlLiteral } from "@/lib/adapters/fetch/ssrf";
import { startSiteServer } from "@/test/site-server";

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

describe("isPublicAddress ranges", () => {
  it("rejects protocol assignments, benchmarking, multicast, reserved and broadcast", () => {
    for (const ip of ["192.0.0.8", "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "ff02::1", "ff0e::1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress("192.0.2.1")).toBe(true);
    expect(isPublicAddress("198.20.0.1")).toBe(true);
  });

  it("judges NAT64, 6to4 and IPv4-compatible addresses by their IPv4", () => {
    expect(isPublicAddress("64:ff9b::10.0.0.1")).toBe(false);
    expect(isPublicAddress("64:ff9b::a9fe:a9fe")).toBe(false);
    expect(isPublicAddress("64:ff9b::8.8.8.8")).toBe(true);
    expect(isPublicAddress("2002:7f00:1::")).toBe(false);
    expect(isPublicAddress("2002:c0a8:101::1")).toBe(false);
    expect(isPublicAddress("2002:808:808::1")).toBe(true);
    expect(isPublicAddress("::127.0.0.1")).toBe(false);
    expect(isPublicAddress("::10.1.2.3")).toBe(false);
    expect(isPublicAddress("::8.8.8.8")).toBe(true);
  });

  it("rejects Teredo and local-use NAT64 outright", () => {
    expect(isPublicAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(false);
    expect(isPublicAddress("64:ff9b:1::8.8.8.8")).toBe(false);
    expect(isPublicAddress("2001:db8::1")).toBe(true);
  });
});

describe("guarded agent", () => {
  const sitePromise = startSiteServer();
  afterAll(async () => (await sitePromise).close());

  it("refuses the connection when the host resolves to a private address at connect time (DNS rebinding)", async () => {
    const site = await sitePromise;
    site.set("/x", { body: "intern" });
    const port = new URL(site.origin).port;
    const url = `http://rebind.test.invalid:${port}/x`;
    // The URL check sees a public address ...
    expect(await isPublicHttpUrl(url, async () => ["93.184.216.34"])).toBe(true);
    // ... the connection resolves to 127.0.0.1 and is refused.
    const agent = createGuardedAgent({ resolveAll: async () => [{ address: "127.0.0.1", family: 4 }] });
    const transport = createGuardedTransport(agent);
    const error = await transport({ service: "crawl", operation: "get", url, timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(error).toBeInstanceOf(BlockedUrlError);
    expect(site.requests.some((r) => r.path === "/x")).toBe(false);
    await agent.close();
  });

  it("refuses a private IP literal without resolving", async () => {
    const site = await sitePromise;
    const agent = createGuardedAgent({ resolveAll: async () => { throw new Error("must not resolve"); } });
    const error = await createGuardedTransport(agent)({ service: "crawl", operation: "get", url: `${site.origin}/x`, timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockedAddressError);
    await agent.close();
  });

  it("connects through the guarded lookup when the address is allowed and caps the body", async () => {
    const site = await sitePromise;
    site.set("/big", { body: "x".repeat(10_000) });
    const port = new URL(site.origin).port;
    const agent = createGuardedAgent({ resolveAll: async () => [{ address: "127.0.0.1", family: 4 }], isAllowedAddress: () => true });
    const res = await createGuardedTransport(agent)({ service: "crawl", operation: "get", url: `http://site.test.invalid:${port}/big`, timeoutMs: 5000, maxBodyBytes: 100 });
    expect(res.status).toBe(200);
    expect(res.body.byteLength).toBe(100);
    expect(res.truncated).toBe(true);
    await agent.close();
  });
});
