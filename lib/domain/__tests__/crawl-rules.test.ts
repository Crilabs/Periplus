import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { crawlRulesSchema, DEFAULT_CRAWL_RULES, urlAllowed } from "@/lib/domain/sources/crawl-rules";

const rules = (r: Record<string, unknown>) => crawlRulesSchema.parse(r);

describe("crawlRulesSchema", () => {
  it("has the spec 05 defaults", () => {
    expect(DEFAULT_CRAWL_RULES).toEqual({
      startUrls: [],
      allow: [],
      deny: [],
      maxDepth: 3,
      maxPages: 500,
      ratePerMinute: 20,
      render: "auto",
      converter: "auto",
      pdf: true,
      boilerplateSelectors: [],
    });
  });

  it("an invalid allow regex is rejected", () => {
    let error: unknown;
    try {
      crawlRulesSchema.parse({ allow: ["(unclosed"] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues.map((i) => i.path.join("."))).toContain("allow.0");
  });

  it("rejects a pattern longer than 200 characters", () => {
    expect(() => crawlRulesSchema.parse({ deny: ["a".repeat(201)] })).toThrow(ZodError);
    expect(crawlRulesSchema.parse({ deny: ["a".repeat(200)] }).deny).toHaveLength(1);
  });

  it("rejects unknown keys and out-of-range limits", () => {
    expect(() => crawlRulesSchema.parse({ bogus: 1 })).toThrow(ZodError);
    expect(() => crawlRulesSchema.parse({ maxDepth: 11 })).toThrow(ZodError);
    expect(() => crawlRulesSchema.parse({ maxPages: 0 })).toThrow(ZodError);
    expect(() => crawlRulesSchema.parse({ ratePerMinute: 121 })).toThrow(ZodError);
    expect(() => crawlRulesSchema.parse({ startUrls: ["not a url"] })).toThrow(ZodError);
    expect(() => crawlRulesSchema.parse({ deny: ["[a-"] })).toThrow(ZodError);
  });
});

describe("urlAllowed", () => {
  it("allows everything on the source domain with empty allow", () => {
    expect(urlAllowed("https://www.example.gr/anything", DEFAULT_CRAWL_RULES, "example.gr")).toEqual({ ok: true });
  });

  it("rejects another registrable domain", () => {
    expect(urlAllowed("https://other.gr/x", DEFAULT_CRAWL_RULES, "example.gr")).toEqual({ ok: false, reason: "other_domain" });
  });

  it("requires a matching allow pattern against path and query", () => {
    const r = rules({ allow: ["^/greece/", "\\?page=\\d+$"] });
    expect(urlAllowed("https://example.gr/greece/x", r, "example.gr")).toEqual({ ok: true });
    expect(urlAllowed("https://example.gr/list?page=2", r, "example.gr")).toEqual({ ok: true });
    expect(urlAllowed("https://example.gr/italy/x", r, "example.gr")).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("deny wins over allow", () => {
    const r = rules({ allow: ["^/greece/"], deny: ["/tag/"] });
    expect(urlAllowed("https://example.gr/greece/tag/x", r, "example.gr")).toEqual({ ok: false, reason: "denied" });
  });

  it("rejects PDFs when pdf is disabled", () => {
    const r = rules({ pdf: false });
    expect(urlAllowed("https://example.gr/guide.PDF", r, "example.gr")).toEqual({ ok: false, reason: "pdf_disabled" });
    expect(urlAllowed("https://example.gr/guide.pdf", DEFAULT_CRAWL_RULES, "example.gr")).toEqual({ ok: true });
  });
});

describe("urlAllowed hardening", () => {
  it("separates private-suffix domains", () => {
    expect(urlAllowed("https://bar.blogspot.com/x", rules({}), "foo.blogspot.com")).toEqual({ ok: false, reason: "other_domain" });
    expect(urlAllowed("https://foo.blogspot.com/x", rules({}), "foo.blogspot.com")).toEqual({ ok: true });
  });
  it("accepts a unicode source domain via punycode", () => {
    expect(urlAllowed("https://www.bücher.de/x", rules({}), "bücher.de")).toEqual({ ok: true });
  });
  it("matches regexes against the decoded path", () => {
    const r = rules({ allow: ["^/ägina/"] });
    expect(urlAllowed("https://a.de/%C3%A4gina/x", r, "a.de")).toEqual({ ok: true });
    expect(urlAllowed("https://a.de/wiki/Foo%3ABar", rules({ allow: ["^/wiki/[^:]+$"] }), "a.de")).toEqual({ ok: false, reason: "not_allowed" });
  });
  it("falls back to the raw path on malformed escapes", () => {
    expect(urlAllowed("https://a.de/wiki/100%", rules({ allow: ["^/wiki/"] }), "a.de")).toEqual({ ok: true });
  });
});
