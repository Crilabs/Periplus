import { describe, expect, it } from "vitest";
import { isSkippedDomain, registrableDomainOf, resolveBlockedDomains } from "../domains";

const patterns = ["navily.com", "tripadvisor.*", "booking.com"];

describe("isSkippedDomain", () => {
  it("matches a wildcard suffix pattern on any TLD and subdomain", () => {
    expect(isSkippedDomain("tripadvisor.de", patterns)).toBe(true);
    expect(isSkippedDomain("www.tripadvisor.com", patterns)).toBe(true);
  });
  it("matches an exact pattern and its subdomains", () => {
    expect(isSkippedDomain("booking.com", patterns)).toBe(true);
    expect(isSkippedDomain("navily.com", patterns)).toBe(true);
    expect(isSkippedDomain("www.navily.com", patterns)).toBe(true);
  });
  it("leaves other domains alone", () => {
    expect(isSkippedDomain("expedia.com", patterns)).toBe(false);
    expect(isSkippedDomain("notnavily.com", patterns)).toBe(false);
  });
});

describe("resolveBlockedDomains", () => {
  it("expands wildcards to concrete domains and keeps the rest", () => {
    const blocked = resolveBlockedDomains(["navily.com", "tripadvisor.*"]);
    expect(blocked).toContain("navily.com");
    expect(blocked).toContain("tripadvisor.com");
    expect(blocked).toContain("tripadvisor.de");
    expect(blocked.some((d) => d.includes("*"))).toBe(false);
  });
});

describe("registrableDomainOf", () => {
  it("returns the registrable domain of a URL", () => {
    expect(registrableDomainOf("https://www.expedia.co.uk/x?y=1")).toBe("expedia.co.uk");
  });
});
