import { describe, expect, it } from "vitest";
import { normalizeUrl, registrableDomain } from "@/lib/domain/sources/urls";

const tp = ["utm_*", "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"];

describe("normalizeUrl", () => {
  it("lower-cases the host, drops default port, fragment and tracking params, sorts the query", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/a/b?utm_source=x&b=2&a=1#top", tp)).toBe("https://example.com/a/b?a=1&b=2");
  });

  it("adds the root path", () => {
    expect(normalizeUrl("http://example.com", tp)).toBe("http://example.com/");
  });

  it("drops an empty query after removing tracking params", () => {
    expect(normalizeUrl("https://x.gr/p?fbclid=1", tp)).toBe("https://x.gr/p");
  });

  it("returns null for non-http schemes and unparsable input", () => {
    expect(normalizeUrl("mailto:a@b.c", tp)).toBeNull();
    expect(normalizeUrl("ftp://example.com/x", tp)).toBeNull();
    expect(normalizeUrl("not a url", tp)).toBeNull();
  });

  it("keeps a non-default port and the path case", () => {
    expect(normalizeUrl("http://Example.com:8080/A/B", tp)).toBe("http://example.com:8080/A/B");
  });

  it("sorts by key, then value, and matches tracking prefixes only with *", () => {
    expect(normalizeUrl("https://e.com/?b=2&a=2&a=1&utm=keep&utm_medium=x", tp)).toBe("https://e.com/?a=1&a=2&b=2&utm=keep");
  });

  it("encodes an IDN host as punycode", () => {
    expect(normalizeUrl("https://Ägina.example/x", tp)).toBe("https://xn--gina-koa.example/x");
  });
});

describe("registrableDomain", () => {
  it("uses the public suffix list", () => {
    expect(registrableDomain("https://de.wikivoyage.org/wiki/Ägina")).toBe("wikivoyage.org");
    expect(registrableDomain("https://www.sailing.co.uk/x")).toBe("sailing.co.uk");
  });

  it("falls back to the host for IP addresses", () => {
    expect(registrableDomain("http://127.0.0.1:8080/")).toBe("127.0.0.1");
  });
});
