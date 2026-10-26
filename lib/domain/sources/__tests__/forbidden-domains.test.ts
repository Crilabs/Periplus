import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { isForbiddenHost, isForbiddenUrl, mentionsForbiddenDomain } from "@/lib/domain/sources/forbidden-domains";

const FORBIDDEN = ["navily.com", "goo.gl", "google.com"];

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
