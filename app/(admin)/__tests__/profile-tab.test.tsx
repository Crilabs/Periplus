import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConflictSide, ProfileSnapshot } from "@/lib/domain/consolidation/types";
import type { AttributeFactsView, ProfileRow, ProfileView } from "@/lib/domain/profile-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("../places/[id]/actions", () => ({ removeProfileEntryAction: vi.fn(), regenerateSummaryAction: vi.fn() }));

import { ProfileTab } from "../places/[id]/profile-tab";
import { profileConfidenceText } from "../_components/labels";
import { TimelineTab } from "../places/[id]/timeline-tab";

const GEO = "00000000-0000-4000-8000-000000000001";
const side = (value: unknown, weight: number): ConflictSide => ({ value, weight, factIds: [], sourceKeys: [], observedFrom: "2026-07-01", observedTo: "2026-07-01" });

const row = (over: Partial<ProfileRow>): ProfileRow => ({
  attribute: "holding",
  label: "Halt",
  value: "good",
  display: "gut",
  origin: "text",
  rule: "holding",
  ruleLabel: "Nur Text",
  confidence: 0.6,
  confidenceClass: "medium",
  observedAt: "2026-07-01",
  lastConfirmedAt: "2026-10-01",
  expired: false,
  onlyGoneSources: false,
  conflict: null,
  conflictTaskId: null,
  pending: null,
  factCount: 1,
  sourceKeys: [],
  entries: null,
  derivedFrom: null,
  ...over,
});

const snapshot = { version: 2, validFrom: "2026-10-19", rulesVersion: "v1", factSchemaVersion: "v2", confidence: 0.62, sourcesCount: 3, documentsCount: 5 } as ProfileSnapshot;

const view = (over: Partial<ProfileView> = {}): ProfileView => ({
  snapshot,
  latest: true,
  createdAt: new Date("2026-10-19T10:00:00Z"),
  runId: null,
  identity: [{ attribute: "geo.name", label: "Name", display: "Testbucht" }],
  rows: [
    row({
      conflict: { attribute: "holding", key: "c1", a: side("good", 1), b: side("poor", 0.8), others: [], resolution: "seasonal" },
      conflictTaskId: "task-c",
      pending: { taskId: "task-u", key: "k", newValue: "poor", display: "schlecht" },
    }),
    row({
      attribute: "hazards",
      label: "Gefahren",
      display: "Fels (Xera), Untiefe",
      expired: true,
      rule: "union",
      entries: [
        { key: "rock", entry: { kind: "rock", name: "Xera" }, display: "Fels (Xera)", inputIds: ["f1"], removable: true, inReview: false },
        { key: "shoal", entry: { kind: "shoal", name: null }, display: "Untiefe", inputIds: ["computation:c1"], removable: false, inReview: false },
      ],
    }),
  ],
  derived: [],
  gaps: [{ attribute: "seabed", label: "Grund", reason: "no_facts" }],
  popularity: 0.5,
  summary: { text: null, status: "empty" },
  versions: 2,
  ...over,
});

const links = { geoObjectId: GEO, placeId: "p1", attrHref: (a: string | null) => (a ? `/places/p1?tab=profile&attr=${a}` : "/places/p1?tab=profile") };
const hazardDetail = (v: ProfileView): AttributeFactsView => ({
  row: v.rows[1]!,
  facts: [],
  computations: [],
  pois: [],
  entries: v.rows[1]!.entries!.map((e) => ({ ...e, facts: [], otherInputs: e.inputIds.filter((id) => id.includes(":")).map(() => ({ type: "computation" as const, id: "0190aaaa-0000-7000-8000-000000000001", kind: "shelter", createdAt: new Date("2026-10-01T08:00:00Z") })) })),
});

describe("ProfileTab", () => {
  it("shows the head, the markers, the gaps and „Eintrag entfernen“ only on removable entries", () => {
    const v = view();
    const html = renderToStaticMarkup(<ProfileTab view={v} selected={hazardDetail(v)} links={links} />);
    expect(html).toContain("2 von 2");
    expect(html).toContain("0,62");
    expect(html).toContain("Testbucht");
    expect(html).toContain("leer (in Prüfung)");
    expect(html).toContain("Konflikt: gut ↔ schlecht");
    expect(html).toContain("Beide gelten (saisonal) (dauerhaft für dieses Wertepaar)");
    expect(html).toContain('href="/review/task-c"');
    expect(html).toContain("Änderung in Prüfung: schlecht");
    expect(html).toContain('href="/review/task-u"');
    expect(html).toContain("abgelaufen");
    expect(html).toContain("Keine Facts");
    expect(html.match(/Eintrag entfernen/g)).toHaveLength(1);
    // the first step is a link, not a form: nothing is removed without the second step
    expect(html).toContain('href="/places/p1?tab=profile&amp;attr=hazards&amp;confirm=rock"');
    expect(html).not.toContain('name="entryKey"');
    expect(html).not.toContain("Wirklich entfernen?");
    expect(html).toContain("(davon 1 aus Berechnung/Highlight)");
    expect(html).toContain("Berechnung: Schutz vom 2026-10-01 08:00");
    expect(html).not.toContain("ohne Beleg");
  });

  it("marks a kept entry without a fact while its removal waits for review (ruling M6-FIN-R3)", () => {
    const v = view();
    const detail = hazardDetail(v);
    detail.entries = detail.entries!.map((e) => (e.key === "rock" ? { ...e, inputIds: [], inReview: true } : e));
    const html = renderToStaticMarkup(<ProfileTab view={v} selected={detail} links={links} />);
    expect(html.match(/ohne Beleg, bleibt bis zur Prüfung der Änderung/g)).toHaveLength(1);
  });

  it("the second step is a server-rendered form „Wirklich entfernen?“ with cancel", () => {
    const v = view();
    const html = renderToStaticMarkup(<ProfileTab view={v} selected={hazardDetail(v)} links={{ ...links, confirm: "rock" }} />);
    expect(html).toContain("Wirklich entfernen?");
    expect(html).toContain(`name="geoObjectId" value="${GEO}"`);
    expect(html).toContain('name="entryKey" value="rock"');
    expect(html).toContain('name="version" value="2"');
    expect(html).toContain("Abbrechen");
    expect(html.match(/name="entryKey"/g)).toHaveLength(1);
    // another entry's confirmation does not arm this one
    expect(renderToStaticMarkup(<ProfileTab view={v} selected={hazardDetail(v)} links={{ ...links, confirm: "other" }} />)).not.toContain("Wirklich entfernen?");
  });

  it("the map popup tells „Profil ohne Konfidenz“ from „kein Profil“", () => {
    expect(profileConfidenceText({ profileConfidence: 0.62, profileClass: "medium", hasProfile: true })).toBe("0,62 (mittel)");
    expect(profileConfidenceText({ profileConfidence: null, profileClass: null, hasProfile: true })).toBe("Profil ohne Konfidenz");
    expect(profileConfidenceText({ profileConfidence: null, profileClass: null, hasProfile: false })).toBe("kein Profil");
  });

  it("„Zusammenfassung neu erzeugen“ is a form on the newest version only (ruling M6-H-R1)", () => {
    const html = renderToStaticMarkup(<ProfileTab view={view()} selected={null} links={links} />);
    expect(html).toContain("Zusammenfassung neu erzeugen");
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain(`name="geoObjectId" value="${GEO}"`);
    expect(html).toContain('name="placeId" value="p1"');
    expect(renderToStaticMarkup(<ProfileTab view={view({ latest: false })} selected={null} links={links} />)).not.toContain("Zusammenfassung neu erzeugen");
  });

  it("marks an older version and shows a notice", () => {
    const html = renderToStaticMarkup(<ProfileTab view={view({ latest: false })} selected={null} links={links} notice="entry_removed" noticeRunId="r1" />);
    expect(html).toContain("(ältere Version)");
    expect(html).toContain("Eintrag entfernt.");
    expect(html).toContain('href="/runs/r1"');
    expect(renderToStaticMarkup(<ProfileTab view={null} selected={null} links={links} />)).toContain("Noch kein Profil.");
  });
});

describe("TimelineTab", () => {
  it("shows the slider, the diff with class changes and the events with severity", () => {
    const html = renderToStaticMarkup(
      <TimelineTab
        placeId="p1"
        baseHref="/places/p1?tab=timeline"
        versions={[
          { version: 1, validFrom: "2026-10-01", createdAt: new Date(), runId: null, events: 1 },
          { version: 2, validFrom: "2026-10-19", createdAt: new Date(), runId: null, events: 1 },
        ]}
        events={[
          { seq: 7, type: "changed", attribute: "hazards", oldValue: [], newValue: [{ kind: "rock", name: null }], severity: "safety", profileVersion: 2, createdAt: new Date("2026-10-19T10:00:00Z") },
        ]}
        view={view()}
        selected={null}
        diff={[{ attribute: "holding", kind: "class", before: "good", after: "good", classBefore: "high", classAfter: "medium" }]}
        asOf={null}
        asOfInvalid={false}
        links={links}
      />,
    );
    expect(html).toContain('type="range"');
    expect(html).toContain('max="2"');
    expect(html).toContain("Stand zum");
    expect(html).toContain("Konfidenzklasse");
    expect(html).toContain("gut (hoch)");
    expect(html).toContain("gut (mittel)");
    expect(html).toContain("Sicherheit");
    expect(html).toContain("Geändert");
    expect(html).toContain('href="/places/p1?tab=timeline&amp;v=2"');
  });

  it("a version without value changes shows its reason", () => {
    const html = renderToStaticMarkup(
      <TimelineTab
        placeId="p1"
        baseHref="/places/p1?tab=timeline"
        versions={[
          { version: 1, validFrom: "2026-10-01", createdAt: new Date(), runId: null, events: 0 },
          { version: 2, validFrom: "2026-10-19", createdAt: new Date(), runId: null, events: 1 },
        ]}
        events={[]}
        view={view()}
        selected={null}
        diff={[]}
        diffNotes={["conflict"]}
        asOf={null}
        asOfInvalid={false}
        links={links}
      />,
    );
    expect(html).toContain("Keine Wert- oder Klassenänderungen.");
    expect(html).toContain("Ein Konflikt wurde entschieden");
  });

  it("an asOf before the first version says so", () => {
    const html = renderToStaticMarkup(
      <TimelineTab
        placeId="p1"
        baseHref="/places/p1?tab=timeline"
        versions={[{ version: 1, validFrom: "2026-10-01", createdAt: new Date(), runId: null, events: 0 }]}
        events={[]}
        view={null}
        selected={null}
        diff={null}
        asOf="2026-09-01"
        asOfInvalid={false}
        links={links}
      />,
    );
    expect(html).toContain("Kein Profil zum 2026-09-01: die erste Version gilt ab 2026-10-01.");
  });
});
