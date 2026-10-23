import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { decideBerth, type Evidence } from "@/lib/domain/research/confirmation";

/*
 * The confirmation rule (spec 5.6) as a pure function: which signals count, what independent means, and when a
 * younger negative blocks.
 */

const config = loadConfig("config");
const cfg = config.research.confirmation;
const decide = (kind: Parameters<typeof decideBerth>[0], evidence: Evidence[], c = cfg) => decideBerth(kind, evidence, c);

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
    quote: "We anchored here",
    pageHash: null,
    ...o,
  };
}

describe("decideBerth: official website of the place (N3b)", () => {
  const website = (o: Partial<Evidence> = {}) =>
    ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina.example", link: "search", quote: "Visitor berths available", ...o });

  it("the website alone does not confirm a marina", () => {
    expect(decide("marina", [website()], cfg)).toMatchObject({ status: "candidate", independentSources: ["marina.example"] });
  });

  it("the website listing visitor berths plus one independent trip report confirms", () => {
    const v = decide("marina", [website(), ev({ domain: "sail-a.example" })], cfg);
    expect(v).toMatchObject({ status: "confirmed", independentSources: ["marina.example", "sail-a.example"] });
  });
});

describe("decideBerth: own website and search page of one domain (N3b)", () => {
  it("count as one source", () => {
    const own = ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina.example", link: "search" });
    const found = ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina.example", link: "search", quote: "Gästeliegeplätze am Steg" });
    expect(decide("marina", [own, found], cfg)).toMatchObject({ status: "candidate", independentSources: ["marina.example"] });
  });
});

describe("decideBerth", () => {
  it("two domains with a first-hand anchored signal confirm an anchorage", () => {
    const v = decide("anchorage", [ev({ domain: "sail-a.example" }), ev({ domain: "sail-b.example" })], cfg);
    expect(v).toMatchObject({ status: "confirmed", independentSources: ["sail-a.example", "sail-b.example"], blockingSignalId: null });
  });

  it("five pages of one domain are one independent source (Review Focus)", () => {
    const v = decide("anchorage", [1, 2, 3, 4, 5].map((i) => ev({ domain: "sail-a.example", observedAt: `2024-0${i}-01` })), cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"], blockingSignalId: null });
    expect(v.reason).toBe("1 von 2 unabhängigen Quellen");
  });

  it("anchored without firstHand does not count", () => {
    const v = decide("anchorage", [ev({ domain: "sail-a.example" }), ev({ domain: "sail-b.example", firstHand: false })], cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"] });
  });

  it("listed_as_berth from a pilot guide plus a trip report confirms", () => {
    const v = decide(
      "anchorage",
      [ev({ kind: "listed_as_berth", firstHand: false, pageKind: "pilot_guide", domain: "guide.example" }), ev({ domain: "sail-a.example" })],
      cfg,
    );
    expect(v).toMatchObject({ status: "confirmed", independentSources: ["guide.example", "sail-a.example"] });
  });

  it("listed_as_berth from a travel guide does not count (no counting page kind, no listing kind)", () => {
    const v = decide(
      "anchorage",
      [ev({ kind: "listed_as_berth", firstHand: false, pageKind: "travel_guide", domain: "travel.example" }), ev({ domain: "sail-a.example" })],
      cfg,
    );
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"], reason: "1 von 2 unabhängigen Quellen" });
  });

  it("listed_as_berth from a forum does not count", () => {
    const v = decide("anchorage", [ev({ kind: "listed_as_berth", firstHand: false, pageKind: "forum", domain: "forum.example" }), ev()], cfg);
    expect(v.status).toBe("candidate");
  });

  it("a signal with confidence 0.5 does not count", () => {
    const v = decide("anchorage", [ev({ domain: "sail-a.example" }), ev({ domain: "sail-b.example", confidence: 0.5 })], cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"] });
  });

  it("a signal of a generated page does not count", () => {
    const v = decide("anchorage", [ev({ domain: "sail-a.example" }), ev({ domain: "sail-b.example", generated: true })], cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["sail-a.example"] });
  });

  it("no evidence: candidate, 0 of 2", () => {
    expect(decide("mooring_field", [], cfg)).toEqual({ status: "candidate", reason: "0 von 2 unabhängigen Quellen", independentSources: [], blockingSignalId: null, signalIds: [] });
  });

  it("a younger prohibition by the authority beside three older positives → no_anchoring (Review Focus)", () => {
    const ban = ev({ kind: "prohibited", firstHand: false, pageKind: "authority", domain: "port-police.example", observedAt: "2025-06-01" });
    const v = decide(
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
    const v = decide("mooring_field", [ev({ kind: "moored_buoy", domain: "a.example", observedAt: "2023-07-01" }), ev({ kind: "moored_buoy", domain: "b.example", observedAt: "2024-07-01" }), neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId, reason: "jüngerer Negativbeleg: Bojen privat (forum.example, 2024-08-01)" });
  });

  it("a negative of the same date as the newest positive counts as younger", () => {
    const neg = ev({ kind: "unsafe", firstHand: true, pageKind: "forum", domain: "forum.example", observedAt: "2024-07-01" });
    const v = decide("anchorage", [ev({ domain: "a.example", observedAt: "2023-07-01" }), ev({ domain: "b.example", observedAt: "2024-07-01" }), neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId });
  });

  it("an older negative does not block", () => {
    const v = decide(
      "anchorage",
      [ev({ kind: "no_space", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2022-07-01" }), ev({ domain: "a.example" }), ev({ domain: "b.example" })],
      cfg,
    );
    expect(v.status).toBe("confirmed");
  });

  it("a negative dated by the fetch (observation = fetch date) blocks dated older positives (Review Focus)", () => {
    // the page has no date, so its observation is the fetch date (2026-10-19): younger than the dated reports
    const neg = ev({ kind: "closed", firstHand: false, pageKind: "trip_report", domain: "undated.example", observedAt: "2026-10-19", observedAtBasis: "fetched" });
    const v = decide("anchorage", [ev({ domain: "a.example", observedAt: "2024-06-01" }), ev({ domain: "b.example", observedAt: "2025-06-01" }), neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId });
  });

  it("a negative that does not count (low confidence, generated page, travel guide) does not block", () => {
    const pos = [ev({ domain: "a.example" }), ev({ domain: "b.example" })];
    for (const neg of [
      ev({ kind: "prohibited", pageKind: "authority", confidence: 0.6, observedAt: "2026-01-01" }),
      ev({ kind: "prohibited", pageKind: "authority", generated: true, observedAt: "2026-01-01" }),
      ev({ kind: "prohibited", pageKind: "travel_guide", observedAt: "2026-01-01" }),
    ]) {
      expect(decide("anchorage", [...pos, neg], cfg).status).toBe("confirmed");
    }
  });

  it("an authority prohibition blocks whatever its age: older than every positive, an anchorage or mooring field is no_anchoring", () => {
    for (const kind of ["anchorage", "mooring_field"] as const) {
      const ban = ev({ kind: "prohibited", firstHand: false, pageKind: "authority", domain: "gov.example", observedAt: "2020-01-01" });
      const v = decide(kind, [ban, ev({ domain: "a.example", observedAt: "2024-07-01" }), ev({ domain: "b.example", observedAt: "2025-07-01" })], cfg);
      expect(v, kind).toMatchObject({ status: "no_anchoring", blockingSignalId: ban.signalId, reason: "Ankerverbot laut Behörde (2020-01-01)" });
    }
  });

  it("an authority prohibition on a marina or port keeps it a candidate (no confirmation, no exclusion)", () => {
    for (const kind of ["marina", "port"] as const) {
      const ban = ev({ kind: "prohibited", firstHand: false, pageKind: "authority", domain: "gov.example", observedAt: "2020-01-01" });
      const official = ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina-x.example", observedAt: "2025-01-01" });
      const v = decide(kind, [ban, official, ev({ kind: "berthed", domain: "sail-a.example", observedAt: "2025-07-01" })], cfg);
      expect(v, kind).toMatchObject({ status: "candidate", blockingSignalId: ban.signalId, reason: "Ankerverbot laut Behörde (2020-01-01)" });
    }
  });

  it("an undated positive (dated by its fetch) never overrides a dated negative", () => {
    const neg = ev({ kind: "buoys_private", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2024-08-01" });
    const undated = ev({ domain: "b.example", observedAt: "2026-10-19", observedAtBasis: "fetched" });
    const v = decide("anchorage", [ev({ domain: "a.example", observedAt: "2023-07-01" }), undated, neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId });
    // only undated positives: any counting negative blocks
    expect(decide("anchorage", [undated, ev({ domain: "c.example", observedAt: "2026-10-19", observedAtBasis: "fetched" }), neg], cfg).status).toBe("candidate");
  });

  it("a dated authority ban beside two positives (one undated) stays blocked", () => {
    const ban = ev({ kind: "prohibited", firstHand: false, pageKind: "authority", domain: "gov.example", observedAt: "2025-06-01" });
    const v = decide("anchorage", [ev({ domain: "a.example", observedAt: "2024-07-01" }), ev({ domain: "b.example", observedAt: "2026-10-19", observedAtBasis: "fetched" }), ban], cfg);
    expect(v).toMatchObject({ status: "no_anchoring", blockingSignalId: ban.signalId });
  });

  it("the switches come from the configuration: officialPlaceKinds and corridorAloneConfirms", () => {
    const two = [ev({ kind: "berthed", domain: "a.example" }), ev({ kind: "berthed", domain: "b.example" })];
    expect(decide("marina", two, { ...cfg, officialPlaceKinds: [] }).status).toBe("confirmed");
    const corridor = [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "corridor" })];
    expect(decide("anchorage", corridor, { ...cfg, corridorAloneConfirms: true }).status).toBe("confirmed");
  });

  it("a prohibition not from the authority makes it a candidate, not no_anchoring", () => {
    const neg = ev({ kind: "prohibited", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2025-01-01" });
    const v = decide("anchorage", [ev({ domain: "a.example", observedAt: "2024-01-01" }), neg], cfg);
    expect(v).toMatchObject({ status: "candidate", blockingSignalId: neg.signalId, reason: "jüngerer Negativbeleg: Ankerverbot (forum.example, 2025-01-01)" });
  });

  it("a marina with its marina page and a trip report is confirmed; the marina page alone is not", () => {
    const official = ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina-x.example" });
    expect(decide("marina", [official, ev({ kind: "berthed", domain: "sail-a.example" })], cfg)).toMatchObject({
      status: "confirmed",
      independentSources: ["marina-x.example", "sail-a.example"],
    });
    expect(decide("marina", [official], cfg)).toMatchObject({ status: "candidate", reason: "keine weitere unabhängige Quelle neben der offiziellen Seite" });
    expect(decide("port", [official, ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina-x.example" })], cfg).status).toBe("candidate");
  });

  it("a marina or port ignores a younger no_space; a bay with it stays blocked", () => {
    const official = ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina-x.example", observedAt: "2024-01-01" });
    const stay = ev({ kind: "berthed", domain: "sail-a.example", observedAt: "2024-06-01" });
    const full = ev({ kind: "no_space", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2025-08-01" });
    for (const kind of ["marina", "port"] as const) {
      expect(decide(kind, [official, stay, full], cfg)).toMatchObject({ status: "confirmed", blockingSignalId: null });
    }
    const bay = [ev({ domain: "a.example", observedAt: "2024-01-01" }), ev({ domain: "b.example", observedAt: "2024-06-01" }), full];
    for (const kind of ["anchorage", "mooring_field"] as const) {
      expect(decide(kind, bay, cfg)).toMatchObject({ status: "candidate", blockingSignalId: full.signalId });
    }
  });

  it("a marina still honours the other negatives (closed) and the ignored set is configurable", () => {
    const official = ev({ kind: "listed_as_berth", firstHand: false, pageKind: "marina", domain: "marina-x.example", observedAt: "2024-01-01" });
    const stay = ev({ kind: "berthed", domain: "sail-a.example", observedAt: "2024-06-01" });
    const closed = ev({ kind: "closed", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2025-08-01" });
    expect(decide("marina", [official, stay, closed], cfg).status).toBe("candidate");
    const full = ev({ kind: "no_space", firstHand: false, pageKind: "forum", domain: "forum.example", observedAt: "2025-08-01" });
    expect(decide("marina", [official, stay, full], { ...cfg, harbourIgnoredNegativeKinds: [] }).status).toBe("candidate");
  });

  it("a marina without an official page is a candidate even with two reports", () => {
    const v = decide("marina", [ev({ kind: "berthed", domain: "a.example" }), ev({ kind: "berthed", domain: "b.example" })], cfg);
    expect(v).toMatchObject({ status: "candidate", reason: "keine offizielle Seite (Marina oder Behörde)" });
  });

  it("an official listing does not confirm an anchorage (only pilot guides list one)", () => {
    const v = decide("anchorage", [ev({ kind: "listed_as_berth", firstHand: false, pageKind: "authority", domain: "gov.example" }), ev({ domain: "a.example" })], cfg);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["a.example"] });
  });

  describe("corridor ruling: discovery alone never confirms", () => {
    it("positives only from pages linked by a corridor route match do not count", () => {
      const v = decide("anchorage", [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "corridor" })], cfg);
      expect(v).toMatchObject({ status: "candidate", independentSources: [], reason: "nur über Routen-Korridor gefunden" });
    });

    it("they count once one counting positive comes from a page linked by search hit or name", () => {
      expect(decide("anchorage", [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "name" })], cfg)).toMatchObject({
        status: "confirmed",
        independentSources: ["a.example", "b.example"],
      });
      expect(decide("anchorage", [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "search" })], cfg).status).toBe("confirmed");
    });

    it("a search-linked signal that does not count does not open the corridor", () => {
      const v = decide("anchorage", [ev({ domain: "a.example", link: "corridor" }), ev({ domain: "b.example", link: "corridor" }), ev({ domain: "c.example", link: "search", firstHand: false })], cfg);
      expect(v).toMatchObject({ status: "candidate", independentSources: [], reason: "nur über Routen-Korridor gefunden" });
    });
  });
});

describe("decideBerth: copies count as one source (spec 5.6, final review 3)", () => {
  const copied = "The bay offers good holding in sand at 5 to 8 m and shelter from the meltemi.";
  it("two domains quoting the same copied pilot-guide sentence are one source, not confirmed", () => {
    const v = decide("anchorage", [ev({ domain: "a.example", quote: copied }), ev({ domain: "b.example", quote: `As they say: ${copied}` })]);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["a.example + b.example"] });
    expect(v.reason).toBe("1 von 2 unabhängigen Quellen (gleicher Text: a.example + b.example)");
  });

  it("two domains in their own words are two sources", () => {
    const v = decide("anchorage", [
      ev({ domain: "a.example", quote: "We dropped the hook in sand at six metres and slept like babies all night long." }),
      ev({ domain: "b.example", quote: "Anchored for two nights in the north corner of the bay, holding was excellent despite the gusts." }),
    ]);
    expect(v).toMatchObject({ status: "confirmed", independentSources: ["a.example", "b.example"] });
  });

  it("the same page on two domains (same content hash) is one source", () => {
    const v = decide("anchorage", [ev({ domain: "a.example", pageHash: "h1" }), ev({ domain: "b.example", pageHash: "h1" })]);
    expect(v).toMatchObject({ status: "candidate", independentSources: ["a.example + b.example"] });
  });

  it("quotes sharing 9 words are two sources (below the copy threshold of 12), 13 words are one", () => {
    expect(config.research.confirmation.copyMinSharedWords).toBe(12);
    const nine = "alpha bravo charlie delta echo foxtrot golf hotel india";
    const thirteen = `${nine} juliet kilo lima mike`;
    const two = decide("anchorage", [ev({ domain: "a.example", quote: `We read: ${nine} and left.` }), ev({ domain: "b.example", quote: `They wrote ${nine}, then sailed on.` })]);
    expect(two).toMatchObject({ status: "confirmed", independentSources: ["a.example", "b.example"] });
    const one = decide("anchorage", [ev({ domain: "a.example", quote: `We read: ${thirteen} and left.` }), ev({ domain: "b.example", quote: `They wrote ${thirteen}, then sailed on.` })]);
    expect(one).toMatchObject({ status: "candidate", independentSources: ["a.example + b.example"] });
  });

  it("exactly 12 shared words is a copy (12 or more), 11 is not", () => {
    const twelve = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    const eleven = twelve.split(" ").slice(0, 11).join(" ");
    const pair = (run: string) => decide("anchorage", [ev({ domain: "a.example", quote: `We read: ${run} and left.` }), ev({ domain: "b.example", quote: `They wrote ${run}, then sailed on.` })]);
    expect(pair(twelve)).toMatchObject({ status: "candidate", independentSources: ["a.example + b.example"] });
    expect(pair(eleven)).toMatchObject({ status: "confirmed", independentSources: ["a.example", "b.example"] });
  });

  it("a copy pair plus a third own source confirms with two sources", () => {
    const v = decide("anchorage", [ev({ domain: "a.example", quote: copied }), ev({ domain: "b.example", quote: copied }), ev({ domain: "c.example" })]);
    expect(v).toMatchObject({ status: "confirmed", independentSources: ["a.example + b.example", "c.example"] });
  });
});
