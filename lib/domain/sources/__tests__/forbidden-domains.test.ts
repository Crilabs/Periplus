import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import {
  ForbiddenSourceDomain,
  isForbiddenHost,
  isForbiddenUrl,
  mentionsForbiddenDomain,
} from "@/lib/domain/sources/forbidden-domains";
import { createManualSource, ensureWhitelistSources, resumeSource } from "@/lib/domain/sources/store";
import { withRollback } from "@/test/db";

const FORBIDDEN = ["navily.com", "goo.gl", "google.com"];
const testDomain = () => `${newId()}.test.invalid`;
/** The real config with `forbiddenDomains` replaced, so a test owns its forbidden domain. */
const withForbidden = (domains: string[]) => {
  const cfg = getConfig();
  return { ...cfg, delivery: { ...cfg.delivery, forbiddenDomains: domains } };
};

describe("forbidden domains", () => {
  it("the configured list covers the pilot's Google domains and short links (final review M-2)", () => {
    const configured = getConfig().delivery.forbiddenDomains;
    for (const url of ["https://maps.google.gr/?q=vathi", "https://g.co/kgs/abc", "https://vathi-taverna.g.page/", "https://www.navily.com/x"]) {
      expect(isForbiddenUrl(url, configured), url).toBe(true);
    }
  });

  it("the configured list covers Google on any public suffix and its asset hosts (SEC-4)", () => {
    const configured = getConfig().delivery.forbiddenDomains;
    for (const url of [
      "https://books.google.co.uk/books?id=x",
      "https://maps.google.it/?q=poros",
      "https://sites.google.fr/view/x",
      "https://google.com.gr/",
      "https://www.gstatic.com/x.png",
      "https://lh3.ggpht.com/x.jpg",
    ]) {
      expect(isForbiddenUrl(url, configured), url).toBe(true);
    }
    for (const host of ["googleblog.example.org", "notgoogle.co.uk", "google.example.org"]) {
      expect(isForbiddenHost(host, configured), host).toBe(false);
    }
    expect(mentionsForbiddenDomain("Karte auf maps.google.it, sehr gut", configured)).toBe(true);
    expect(mentionsForbiddenDomain("Siehe BOOKS.GOOGLE.CO.UK.", configured)).toBe(true);
    expect(mentionsForbiddenDomain("Ich google.Dann fahren wir", configured)).toBe(false);
    expect(mentionsForbiddenDomain("Guter Halt auf Sand, Schutz vor Meltemi", configured)).toBe(false);
  });

  it("a wildcard entry `label.*` forbids that registrable label on any ICANN public suffix (SEC-4)", () => {
    const wildcard = ["google.*"];
    expect(isForbiddenHost("google.de", wildcard)).toBe(true);
    expect(isForbiddenHost("Maps.Google.Co.Uk.", wildcard)).toBe(true);
    expect(isForbiddenHost("google.invalid-tld-xyz", wildcard)).toBe(false);
    expect(isForbiddenHost("google.github.io", wildcard)).toBe(false);
    expect(mentionsForbiddenDomain("auf sites.google.fr/x", wildcard)).toBe(true);
    expect(mentionsForbiddenDomain("bei google", wildcard)).toBe(false);
  });

  it("a host, its subdomains and the fully qualified form with a trailing dot are forbidden", () => {
    expect(isForbiddenHost("navily.com", FORBIDDEN)).toBe(true);
    expect(isForbiddenHost("FR.Navily.com", FORBIDDEN)).toBe(true);
    expect(isForbiddenHost("navily.com.", FORBIDDEN)).toBe(true);
    expect(isForbiddenHost("notnavily.com", FORBIDDEN)).toBe(false);
    expect(isForbiddenUrl("https://navily.com./spot/1", FORBIDDEN)).toBe(true);
    expect(isForbiddenUrl("https://www.navily.com/spot/1", FORBIDDEN)).toBe(true);
    expect(isForbiddenUrl("https://example.org/navily.com", FORBIDDEN)).toBe(false);
    expect(isForbiddenUrl("not a url", FORBIDDEN)).toBe(true);
  });

  it.each([
    ["Laut navily.com/spot/12 guter Halt", true],
    ["Siehe goo.gl/xyz", true],
    ["Karte auf maps.google.com.", true],
    ["NAVILY.COM sagt", true],
    ["Bucht bei notnavily.com", false],
    ["navily.community", false],
    ["Guter Halt auf Sand, Schutz vor Meltemi", false],
  ])("text %j names a forbidden domain: %s", (text, expected) => {
    expect(mentionsForbiddenDomain(text, FORBIDDEN)).toBe(expected);
  });
});

describe("source guards (ruling M6-D-R2)", () => {
  it("createManualSource refuses a forbidden domain, also as a URL of a subdomain", () =>
    withRollback(async (tx) => {
      await expect(createManualSource(tx, { domain: "https://www.navily.com/de", name: "Navily", type: "forum" })).rejects.toThrow(
        ForbiddenSourceDomain,
      );
      const forbidden = testDomain();
      await expect(createManualSource(tx, { domain: `fr.${forbidden}`, name: "X", type: "forum" }, withForbidden([forbidden]))).rejects.toThrow(
        ForbiddenSourceDomain,
      );
      expect(await tx.select().from(sources).where(eq(sources.domain, forbidden))).toEqual([]);
    }));

  it("the whitelist never creates a source on a forbidden domain", () =>
    withRollback(async (tx) => {
      // own registrable domains (`<uuid>.test.invalid` would all fold into test.invalid)
      const forbidden = `w${newId()}.invalid`;
      const allowed = `w${newId()}.invalid`;
      const entry = (domain: string) => ({ ...getConfig().whitelist[0]!, domain, name: domain });
      const cfg = { ...withForbidden([forbidden]), whitelist: [entry(forbidden), entry(allowed)] };
      expect(await ensureWhitelistSources(tx, cfg)).toEqual({ created: 1 });
      expect(await tx.select().from(sources).where(eq(sources.domain, forbidden))).toEqual([]);
      expect(await tx.select().from(sources).where(eq(sources.domain, allowed))).toHaveLength(1);
      // a forbidden entry below a registrable domain: the entry's own host counts
      const parent = `w${newId()}.invalid`;
      const sub = { ...withForbidden([`fr.${parent}`]), whitelist: [entry(`fr.${parent}`)] };
      expect(await ensureWhitelistSources(tx, sub)).toEqual({ created: 0 });
    }));

  it("a paused source on a forbidden domain is not resumed", () =>
    withRollback(async (tx) => {
      const forbidden = testDomain();
      const [row] = await tx
        .insert(sources)
        .values({ domain: forbidden, name: "x", type: "forum", weight: 0.4, status: "paused", crawlRules: DEFAULT_CRAWL_RULES, origin: "manual" })
        .returning({ id: sources.id });
      await expect(resumeSource(tx, row!.id, withForbidden([forbidden]))).rejects.toThrow(ForbiddenSourceDomain);
      const [after] = await tx.select({ status: sources.status }).from(sources).where(eq(sources.id, row!.id));
      expect(after!.status).toBe("paused");
    }));
});
