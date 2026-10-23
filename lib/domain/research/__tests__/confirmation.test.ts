import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { decideBerth, type Evidence } from "@/lib/domain/research/confirmation";

/*
 * The confirmation rule (spec 5.6) as a pure function: which signals count, what independent means, and when a
 * younger negative blocks.
 */

const cfg = loadConfig("config").research.confirmation;

let seq = 0;
function ev(o: Partial<Evidence> = {}): Evidence {
  seq += 1;
  return {
    signalId: `s${seq}`,
    kind: "anchored",
    firstHand: true,
    confidence: 0.9,
    observedAt: "2024-06-15",
    observedAtBasis: "explicit",
    domain: "sail-a.example",
    pageKind: "trip_report",
    generated: false,
    link: "search",
    ...o,
  };
}

describe("decideBerth", () => {
  it("two domains with a first-hand anchored signal confirm an anchorage", () => {
    const v = decideBerth("anchorage", [ev({ domain: "sail-a.example" }), ev({ domain: "sail-b.example" })], cfg);
    expect(v).toMatchObject({ status: "confirmed", independentSources: ["sail-a.example", "sail-b.example"], blockingSignalId: null });
  });

  it("five pages of one domain are one independent source (Review Focus)", () => {
    const v = decideBerth("anchorage", [1, 2, 3, 4, 5].map((i) => ev({ domain: "sail-a.example", observedAt: `2024-0${i}-01` })), cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"], blockingSignalId: null });
    expect(v.reason).toBe("1 von 2 unabhängigen Quellen");
  });

  it("anchored without firstHand does not count", () => {
    const v = decideBerth("anchorage", [ev({ domain: "sail-a.example" }), ev({ domain: "sail-b.example", firstHand: false })], cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"] });
  });

  it("listed_as_berth from a pilot guide plus a trip report confirms", () => {
    const v = decideBerth(
      "anchorage",
      [ev({ kind: "listed_as_berth", firstHand: false, pageKind: "pilot_guide", domain: "guide.example" }), ev({ domain: "sail-a.example" })],
      cfg,
    );
    expect(v).toMatchObject({ status: "confirmed", independentSources: ["guide.example", "sail-a.example"] });
  });

  it("listed_as_berth from a travel guide does not count (no counting page kind, no listing kind)", () => {
    const v = decideBerth(
      "anchorage",
      [ev({ kind: "listed_as_berth", firstHand: false, pageKind: "travel_guide", domain: "travel.example" }), ev({ domain: "sail-a.example" })],
      cfg,
    );
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"], reason: "1 von 2 unabhängigen Quellen" });
  });

  it("listed_as_berth from a forum does not count", () => {
    const v = decideBerth("anchorage", [ev({ kind: "listed_as_berth", firstHand: false, pageKind: "forum", domain: "forum.example" }), ev()], cfg);
    expect(v.status).toBe("candidate");
  });

  it("a signal with confidence 0.5 does not count", () => {
    const v = decideBerth("anchorage", [ev({ domain: "sail-a.example" }), ev({ domain: "sail-b.example", confidence: 0.5 })], cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"] });
  });

  it("a signal of a generated page does not count", () => {
    const v = decideBerth("anchorage", [ev({ domain: "sail-a.example" }), ev({ domain: "sail-b.example", generated: true })], cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"] });
  });

  it("no evidence: candidate, 0 of 2", () => {
    expect(decideBerth("mooring_field", [], cfg)).toEqual({ status: "candidate", reason: "0 von 2 unabhängigen Quellen", independentSources: [], blockingSignalId: null, signalIds: [] });
  });

  it("a younger prohibition by the authority beside three older positives → no_anchoring (Review Focus)", () => {
    const ban = ev({ kind: "prohibited", firstHand: false, pageKind: "authority", domain: "port-police.example", observedAt: "2025-06-01" });
    const v = decideBerth(
      "anchorage",
      [ev({ domain: "a.example", observedAt: "2023-07-01" }), ev({ domain: "b.example", observedAt: "2024-07-01" }), ev({ domain: "c.example", observedAt: "2024-08-01" }), ban],
      cfg,
    );
    expect(v).toMatchObject({ status: "no_anchoring", blockingSignalId: ban.signalId, reason: "Ankerverbot laut Behörde (2025-06-01)" });
    expect(v.signalIds).toHaveLength(4);
    expect(v.signalIds).toContain(ban.signalId);
  });

  it("a younger buoys_private from a forum → candidate with the reason (Review Focus)", () => {
    const neg = ev({ kind: "buoys_private", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2024-08-01" });
    const v = decideBerth("mooring_field", [ev({ kind: "moored_buoy", domain: "a.example", observedAt: "2023-07-01" }), ev({ kind: "moored_buoy", domain: "b.example", observedAt: "2024-07-01" }), neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId, reason: "jüngerer Negativbeleg: Bojen privat (forum.example, 2024-08-01)" });
  });

  it("a negative of the same date as the newest positive counts as younger", () => {
    const neg = ev({ kind: "unsafe", firstHand: true, pageKind: "forum", domain: "forum.example", observedAt: "2024-07-01" });
    const v = decideBerth("anchorage", [ev({ domain: "a.example", observedAt: "2023-07-01" }), ev({ domain: "b.example", observedAt: "2024-07-01" }), neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId });
  });

  it("an older negative does not block", () => {
    const v = decideBerth(
      "anchorage",
      [ev({ kind: "no_space", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2022-07-01" }), ev({ domain: "a.example" }), ev({ domain: "b.example" })],
      cfg,
    );
    expect(v.status).toBe("confirmed");
  });

  it("a negative dated by the fetch (observation = fetch date) blocks dated older positives (Review Focus)", () => {
    // the page has no date, so its observation is the fetch date (2026-10-19): younger than the dated reports
    const neg = ev({ kind: "closed", firstHand: false, pageKind: "trip_report", domain: "undated.example", observedAt: "2026-10-19", observedAtBasis: "fetched" });
    const v = decideBerth("anchorage", [ev({ domain: "a.example", observedAt: "2024-06-01" }), ev({ domain: "b.example", observedAt: "2025-06-01" }), neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId });
  });

  it("a negative that does not count (low confidence, generated page, travel guide) does not block", () => {
    const pos = [ev({ domain: "a.example" }), ev({ domain: "b.example" })];
    for (const neg of [
      ev({ kind: "prohibited", pageKind: "authority", confidence: 0.6, observedAt: "2026-01-01" }),
      ev({ kind: "prohibited", pageKind: "authority", generated: true, observedAt: "2026-01-01" }),
      ev({ kind: "prohibited", pageKind: "travel_guide", observedAt: "2026-01-01" }),
    ]) {
      expect(decideBerth("anchorage", [...pos, neg], cfg).status).toBe("confirmed");
    }
  });

  it("an authority prohibition blocks whatever its age: older than every positive, an anchorage or mooring field is no_anchoring", () => {
    for (const kind of ["anchorage", "mooring_field"] as const) {
      const ban = ev({ kind: "prohibited", firstHand: false, pageKind: "authority", domain: "gov.example", observedAt: "2020-01-01" });
      const v = decideBerth(kind, [ban, ev({ domain: "a.example", observedAt: "2024-07-01" }), ev({ domain: "b.example", observedAt: "2025-07-01" })], cfg);
      expect(v, kind).toMatchObject({ status: "no_anchoring", blockingSignalId: ban.signalId, reason: "Ankerverbot laut Behörde (2020-01-01)" });
    }
  });

  it("an authority prohibition on a marina or port keeps it a candidate (no confirmation, no exclusion)", () => {
    for (const kind of ["marina", "port"] as const) {
      const ban = ev({ kind: "prohibited", firstHand: false, pageKind: "authority", domain: "gov.example", observedAt: "2020-01-01" });
      const official = ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina-x.example", observedAt: "2025-01-01" });
      const v = decideBerth(kind, [ban, official, ev({ kind: "berthed", domain: "sail-a.example", observedAt: "2025-07-01" })], cfg);
      expect(v, kind).toMatchObject({ status: "candidate", blockingSignalId: ban.signalId, reason: "Ankerverbot laut Behörde (2020-01-01)" });
    }
  });

  it("an undated positive (dated by its fetch) never overrides a dated negative", () => {
    const neg = ev({ kind: "buoys_private", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2024-08-01" });
    const undated = ev({ domain: "b.example", observedAt: "2026-10-19", observedAtBasis: "fetched" });
    const v = decideBerth("anchorage", [ev({ domain: "a.example", observedAt: "2023-07-01" }), undated, neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId });
    // only undated positives: any counting negative blocks
    expect(decideBerth("anchorage", [undated, ev({ domain: "c.example", observedAt: "2026-10-19", observedAtBasis: "fetched" }), neg], cfg).status).toBe("candidate");
  });

  it("a dated authority ban beside two positives (one undated) stays blocked", () => {
    const ban = ev({ kind: "prohibited", firstHand: false, pageKind: "authority", domain: "gov.example", observedAt: "2025-06-01" });
    const v = decideBerth("anchorage", [ev({ domain: "a.example", observedAt: "2024-07-01" }), ev({ domain: "b.example", observedAt: "2026-10-19", observedAtBasis: "fetched" }), ban], cfg);
    expect(v).toMatchObject({ status: "no_anchoring", blockingSignalId: ban.signalId });
  });

  it("the switches come from the configuration: officialPlaceKinds and corridorAloneConfirms", () => {
    const two = [ev({ kind: "berthed", domain: "a.example" }), ev({ kind: "berthed", domain: "b.example" })];
    expect(decideBerth("marina", two, { ...cfg, officialPlaceKinds: [] }).status).toBe("confirmed");
    const corridor = [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "corridor" })];
    expect(decideBerth("anchorage", corridor, { ...cfg, corridorAloneConfirms: true }).status).toBe("confirmed");
  });

  it("a prohibition not from the authority makes it a candidate, not no_anchoring", () => {
    const neg = ev({ kind: "prohibited", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2025-01-01" });
    const v = decideBerth("anchorage", [ev({ domain: "a.example", observedAt: "2024-01-01" }), neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId, reason: "jüngerer Negativbeleg: Ankerverbot (forum.example, 2025-01-01)" });
  });

  it("a marina with its marina page and a trip report is confirmed; the marina page alone is not", () => {
    const official = ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina-x.example" });
    expect(decideBerth("marina", [official, ev({ kind: "berthed", domain: "sail-a.example" })], cfg)).toMatchObject({
      status: "confirmed",
      independentSources: ["marina-x.example", "sail-a.example"],
    });
    expect(decideBerth("marina", [official], cfg)).toMatchObject({ status: "candidate", reason: "keine weitere unabhängige Quelle neben der offiziellen Seite" });
    expect(decideBerth("port", [official, ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina-x.example" })], cfg).status).toBe("candidate");
  });

  it("a marina without an official page is a candidate even with two reports", () => {
    const v = decideBerth("marina", [ev({ kind: "berthed", domain: "a.example" }), ev({ kind: "berthed", domain: "b.example" })], cfg);
    expect(v).toMatchObject({ status: "candidate", reason: "keine offizielle Seite (Marina oder Behörde)" });
  });

  it("an official listing does not confirm an anchorage (only pilot guides list one)", () => {
    const v = decideBerth("anchorage", [ev({ kind: "listed_as_berth", firstHand: false, pageKind: "authority", domain: "gov.example" }), ev({ domain: "a.example" })], cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["a.example"] });
  });

  describe("corridor ruling: discovery alone never confirms", () => {
    it("positives only from pages linked by a corridor route match do not count", () => {
      const v = decideBerth("anchorage", [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "corridor" })], cfg);
      expect(v).toMatchObject({ status: "candidate", independentSources: [], reason: "nur über Routen-Korridor gefunden" });
    });

    it("they count once one counting positive comes from a page linked by search hit or name", () => {
      expect(decideBerth("anchorage", [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "name" })], cfg)).toMatchObject({
        status: "confirmed",
        independentSources: ["a.example", "b.example"],
      });
      expect(decideBerth("anchorage", [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "search" })], cfg).status).toBe("confirmed");
    });

    it("a search-linked signal that does not count does not open the corridor", () => {
      const v = decideBerth("anchorage", [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "corridor" }), ev({ domain: "c.example", link: "search", firstHand: false })], cfg);
      expect(v).toMatchObject({ status: "candidate", independentSources: [], reason: "nur über Routen-Korridor gefunden" });
    });
  });
});
