import { sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import type { ChangeSeverity, ChangeType } from "@/lib/db/schema/profiles";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import { severityFor } from "@/lib/domain/consolidation/changes";
import { loadInputs } from "@/lib/domain/consolidation/inputs";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";
import type { ConsolidationInput } from "@/lib/domain/rules/types";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { latestProfiles } from "@/lib/domain/timeline";
import { subdivisionObjectIds } from "./scope";
import {
  applyEdit,
  editBase,
  preflightScenario,
  ScenarioEditAmbiguous,
  ScenarioEditNotApplicable,
  type ExpectedEvent,
  type RevisitScenario,
  type ScenarioEntry,
} from "./scenario";

/*
 * Draft of a simulated revisit scenario from the archive of a subdivision (spec 10, plan Task 15): ten entries, each built
 * from a document of the subdivision as it is now (its current version), with the change events the M5 rules lead to
 * (ruling M7-P26). A text edit searches for one verbatim sentence of the current version (found exactly once) that
 * quotes the fact it changes and no fact of another attribute; the replacement or appended text is Periplus' own
 * short sentence, so the draft holds no third-party text beyond the sentences it searches for. Every entry passes
 * `preflightScenario`; each document is used once. The categories:
 *
 *   2 × taverna negated   a `highlight.food` (present) of a source weighing more than `change.strongWeight`, the only
 *                         input of the attribute at the place, its sentence replaced by a closed taverna
 *                         ⇒ changed highlight.food (severity by `severity`, notable)
 *   1 × taverna deleted   the same statement with the same value also from another source; the sentence is deleted
 *                         ⇒ new version, no event
 *   2 × depth changed     a numeric `depth.*` of a source weighing more than `change.strongWeight` at a place whose
 *                         raster depth has confidence < `rules.bathymetry.weakRasterConfidence`, the only text input
 *                         of the attribute, made shallower (half, at least 1 m: the shallower wins, M5-B-R3)
 *                         ⇒ changed (new_attribute without a profile value) depth.* safety
 *   2 × gone              a document every fact of which another document or a computation states with the same
 *                         value ⇒ gone, no event
 *   1 × ban appended      an `authority` document about a place gets a ban the place's prohibitions lack
 *                         ⇒ changed (new_attribute without prohibitions) prohibitions safety (safety lists take a new
 *                         entry at once, M5-F-R3 I-3)
 *   1 × buoys contradicted  a forum's `mooring.buoys` equal to the profile's, negated, with no other input stating the
 *                         new value ⇒ uncertain mooring.buoys notable (a weak source alone, M5-F-R3)
 *   1 × touch             any other document ⇒ unchanged, no event
 *
 * Entries are judged against the archive as it is, so they must not depend on each other: a document another entry's
 * expectation relies on (the second source of a deleted taverna, the other sources of a gone page) is never edited,
 * deleted or dropped by another entry, only fetched again (`touch`). A category the archive cannot fill is reported
 * in `gaps` (German, for the CLI). `note` names the rule of each entry.
 * The draft is a proposal: Christian reviews it before the revisit (run book); a real pilot scenario quotes
 * third-party pages and lives under the git-ignored `data/sim/`, never in the repo.
 */

export type DraftKind = "taverna_negated" | "taverna_deleted" | "depth_changed" | "gone" | "ban_appended" | "buoys_contradicted" | "touch";

/** How many entries of each kind the draft proposes, in this order (spec 10: „10 Änderungen“). */
export const DRAFT_PLAN: ReadonlyArray<{ kind: DraftKind; count: number; label: string }> = [
  { kind: "taverna_negated", count: 2, label: "Taverne verneint" },
  { kind: "taverna_deleted", count: 1, label: "Taverne-Satz gestrichen" },
  { kind: "depth_changed", count: 2, label: "Tiefe geändert" },
  { kind: "gone", count: 2, label: "Seite weg (404)" },
  { kind: "ban_appended", count: 1, label: "Verbot angehängt" },
  { kind: "buoys_contradicted", count: 1, label: "Bojen widersprochen" },
  { kind: "touch", count: 1, label: "unverändert abgerufen" },
];

/** Why a kind found too few documents, for the gap line. */
const GAP_REASON: Record<DraftKind, string> = {
  taverna_negated: "keine (weitere) Taverne als einziger Beleg einer Quelle mit Gewicht über change.strongWeight",
  taverna_deleted: "keine (weitere) Taverne, die eine zweite Quelle mit demselben Wert nennt",
  depth_changed: "keine (weitere) Tiefe einer starken Quelle an einem Ort mit schwachem Raster",
  gone: "kein (weiteres) Dokument, dessen Facts andere Quellen oder Berechnungen mit demselben Wert stützen",
  ban_appended: "kein (weiteres) Dokument einer Behörde (authority) über einen bestätigten Ort",
  buoys_contradicted: "keine (weitere) Bojen-Aussage eines Forums, die dem Profil entspricht",
  touch: "kein Dokument mehr übrig",
};

export type DraftInput = { subdivisionKey: string; seed: number; today?: string };
export type ScenarioDraft = { scenario: RevisitScenario; gaps: string[] };

type Place = { geoObjectId: string; publicId: string };

type Doc = {
  id: string;
  url: string;
  language: string | null;
  sourceType: string;
  sourceWeight: number;
  /** Current version's Markdown, or null when the document has no recorded current version. */
  markdown: string | null;
};

type TextFact = ConsolidationInput & { factId: string; documentId: string; geoObjectId: string; quote: string };

type Context = {
  cfg: ConsolidationConfig;
  places: Map<string, Place>;
  profiles: Map<string, ProfileSnapshot>;
  /** Every input per geo object of the subdivision. */
  inputs: Map<string, ConsolidationInput[]>;
  texts: TextFact[];
  docs: Map<string, Doc>;
};

/**
 * A proposed entry before it gets its id, with the documents its expectation relies on (another source still stating
 * the value): the draft never edits, deletes or drops those in another entry (only a `touch` may fetch them again).
 */
type Proposal = Omit<ScenarioEntry, "id"> & { reliesOn?: string[] };

/** A deterministic PRNG (mulberry32) for the seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const german = (doc: Doc) => (doc.language ?? "").toLowerCase().startsWith("de");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every span of `markdown` matching `text` up to whitespace runs. */
function spans(markdown: string, text: string): Array<{ start: number; end: number }> {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const pattern = new RegExp(trimmed.split(/\s+/).map(escapeRegExp).join("\\s+"), "gu");
  return [...markdown.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/** Whether `text` occurs exactly once (on token boundaries, as a scenario edit searches for it). */
function occursOnce(markdown: string, text: string, url: string): boolean {
  try {
    applyEdit(markdown, { op: "delete", text }, url);
    return true;
  } catch (error) {
    if (error instanceof ScenarioEditNotApplicable || error instanceof ScenarioEditAmbiguous) return false;
    throw error;
  }
}

const SENTENCE_END = /[.!?]/;

/**
 * The sentence of `markdown` holding the quote (found exactly once): from the previous sentence end or line break to
 * the next sentence end (`.`, `!`, `?` before whitespace or the end) or line break, without list or heading marks.
 * Null when the quote is not found exactly once, or the sentence is not found exactly once.
 */
function sentenceOf(markdown: string, quote: string, url: string): { sentence: string; start: number; end: number } | null {
  const found = spans(markdown, quote);
  if (found.length !== 1) return null;
  const { start: qStart, end: qEnd } = found[0]!;
  let start = 0;
  for (let i = qStart - 1; i >= 0; i--) {
    const c = markdown[i]!;
    if (c === "\n" || (SENTENCE_END.test(c) && /\s/.test(markdown[i + 1] ?? ""))) {
      start = i + 1;
      break;
    }
  }
  let end = markdown.length;
  for (let j = Math.max(qStart, qEnd - 1); j < markdown.length; j++) {
    const c = markdown[j]!;
    if (c === "\n") {
      end = j;
      break;
    }
    if (SENTENCE_END.test(c) && (j + 1 === markdown.length || /\s/.test(markdown[j + 1]!))) {
      end = j + 1;
      break;
    }
  }
  let sentence = markdown.slice(start, end);
  const lead = /^\s*(?:(?:#+|>|[-*+]|\d+\.)\s+)*/.exec(sentence)![0];
  sentence = sentence.slice(lead.length).trimEnd();
  if (sentence === "" || !occursOnce(markdown, sentence, url)) return null;
  return { sentence, start: start + lead.length, end: start + lead.length + sentence.length };
}

/**
 * The sentence of the fact's quote in its document's current version, when editing it changes nothing but the
 * fact's attribute at its object: no quote of another fact of the document (another object or attribute) lies in it.
 */
function editableSentence(ctx: Context, fact: TextFact): { sentence: string; doc: Doc } | null {
  const doc = ctx.docs.get(fact.documentId);
  if (!doc?.markdown) return null;
  const found = sentenceOf(doc.markdown, fact.quote, doc.url);
  if (!found) return null;
  for (const other of ctx.texts) {
    if (other.documentId !== doc.id || (other.geoObjectId === fact.geoObjectId && other.attribute === fact.attribute)) continue;
    if (spans(doc.markdown, other.quote).some((s) => s.start < found.end && s.end > found.start)) return null;
  }
  return { sentence: found.sentence, doc };
}

const inputsOf = (ctx: Context, geoObjectId: string, attribute: string) => (ctx.inputs.get(geoObjectId) ?? []).filter((i) => i.attribute === attribute);

function event(ctx: Context, place: Place, attribute: string, type: ChangeType, oldValue: unknown, newValue: unknown, eventAttribute = attribute): ExpectedEvent {
  const severity: ChangeSeverity = severityFor(attribute, oldValue, newValue, ctx.cfg);
  return { subject: place.publicId, attribute: eventAttribute, type, severity };
}

const fmt = (n: number) => String(n).replace(".", ",");

function tavernaNegated(ctx: Context): Array<{ documentId: string; proposal: () => Proposal | null }> {
  const strong = ctx.cfg.change.strongWeight;
  return ctx.texts
    .filter((f) => f.attribute === "highlight.food" && isObject(f.value) && f.value.present === true && f.sourceWeight > strong && ctx.places.has(f.geoObjectId))
    .map((f) => ({
      documentId: f.documentId,
      proposal: () => {
        const place = ctx.places.get(f.geoObjectId)!;
        const old = ctx.profiles.get(f.geoObjectId)?.attributes["highlight.food"];
        if (!isObject(old) || old.present !== true) return null;
        if (!inputsOf(ctx, f.geoObjectId, "highlight.food").every((i) => i.documentId === f.documentId)) return null;
        const editable = editableSentence(ctx, f);
        if (!editable) return null;
        const names = Array.isArray((f.value as { names?: unknown }).names) ? ((f.value as { names: unknown[] }).names as string[]) : [];
        const name = names.find((n) => typeof n === "string" && editable.sentence.includes(n));
        const to = german(editable.doc)
          ? `Die Taverne ${name ? `${name} ` : ""}hat geschlossen.`
          : `The taverna ${name ? `${name} ` : ""}has closed.`;
        if (to === editable.sentence) return null;
        return {
          url: editable.doc.url,
          edit: { op: "replace", from: editable.sentence, to },
          expect: { document: "new_version", events: [event(ctx, place, "highlight.food", "changed", old, { present: false, names: name ? [name] : [] })] },
          note: `taverna negated by a ${editable.doc.sourceType} (weight ${fmt(f.sourceWeight)} > change.strongWeight ${fmt(strong)}), the only input of highlight.food at the place: changed (M5 change rule, ruling M7-P26)`,
        };
      },
    }));
}

function tavernaDeleted(ctx: Context): Array<{ documentId: string; proposal: () => Proposal | null }> {
  return ctx.texts
    .filter((f) => f.attribute === "highlight.food" && isObject(f.value) && f.value.present === true && ctx.places.has(f.geoObjectId))
    .map((f) => ({
      documentId: f.documentId,
      proposal: () => {
        const old = ctx.profiles.get(f.geoObjectId)?.attributes["highlight.food"];
        if (!same(old, f.value)) return null;
        const second = inputsOf(ctx, f.geoObjectId, "highlight.food").filter(
          (i) => i.origin === "text" && i.sourceKey !== f.sourceKey && !i.gone && same(i.value, f.value),
        );
        if (second.length === 0) return null;
        const editable = editableSentence(ctx, f);
        if (!editable) return null;
        return {
          url: editable.doc.url,
          edit: { op: "delete", text: editable.sentence },
          expect: { document: "new_version", events: [] },
          note: "taverna sentence deleted; another source states the same highlight.food, the value stays: no event (M5 rules, ruling M7-P26)",
          reliesOn: second.map((i) => i.documentId!),
        };
      },
    }));
}

/** The one number of `sentence` equal to `value` (`,` or `.` as decimal mark), null when there is not exactly one. */
function numberSpan(sentence: string, value: number): { start: number; end: number } | null {
  const hits = [...sentence.matchAll(/(?<![\p{L}\p{N}.,])\d+(?:[.,]\d+)?(?![\p{N}]|[.,]\d)/gu)].filter((m) => Number(m[0].replace(",", ".")) === value);
  if (hits.length !== 1) return null;
  return { start: hits[0]!.index, end: hits[0]!.index + hits[0]![0].length };
}

function depthChanged(ctx: Context): Array<{ documentId: string; proposal: () => Proposal | null }> {
  const strong = ctx.cfg.change.strongWeight;
  const weak = ctx.cfg.rules.bathymetry.weakRasterConfidence;
  return ctx.texts
    .filter((f) => f.attribute.startsWith("depth.") && typeof f.value === "number" && f.sourceWeight > strong && ctx.places.has(f.geoObjectId))
    .map((f) => ({
      documentId: f.documentId,
      proposal: () => {
        const place = ctx.places.get(f.geoObjectId)!;
        const inputs = inputsOf(ctx, f.geoObjectId, f.attribute);
        const raster = inputs.filter((i) => i.origin === "computed");
        if (raster.length === 0 || !raster.every((r) => r.confidence < weak)) return null;
        if (inputs.some((i) => i.origin !== "computed" && i.documentId !== f.documentId)) return null;
        const value = f.value as number;
        const next = Math.max(1, Math.floor(value / 2));
        if (next >= value) return null;
        const editable = editableSentence(ctx, f);
        if (!editable) return null;
        const span = numberSpan(editable.sentence, value);
        if (!span) return null;
        const to = editable.sentence.slice(0, span.start) + String(next) + editable.sentence.slice(span.end);
        const old = ctx.profiles.get(f.geoObjectId)?.attributes[f.attribute];
        const type: ChangeType = old === undefined || old === null ? "new_attribute" : "changed";
        return {
          url: editable.doc.url,
          edit: { op: "replace", from: editable.sentence, to },
          expect: { document: "new_version", events: [event(ctx, place, f.attribute, type, old, next, "depth.*")] },
          note: `${f.attribute} ${fmt(value)} → ${next} m by a ${editable.doc.sourceType} (weight ${fmt(f.sourceWeight)} > change.strongWeight ${fmt(strong)}) over a raster with confidence < ${fmt(weak)}: the shallower wins (M5-B-R3), ${type} safety (ruling M7-P26)`,
        };
      },
    }));
}

function gone(ctx: Context, outside: Set<string>): Array<{ documentId: string; proposal: () => Proposal | null }> {
  const byDoc = new Map<string, TextFact[]>();
  for (const f of ctx.texts) byDoc.set(f.documentId, [...(byDoc.get(f.documentId) ?? []), f]);
  return [...byDoc.entries()].map(([documentId, facts]) => ({
    documentId,
    proposal: () => {
      const doc = ctx.docs.get(documentId);
      if (!doc || outside.has(documentId)) return null;
      const reliesOn: string[] = [];
      for (const f of facts) {
        const support = inputsOf(ctx, f.geoObjectId, f.attribute).filter(
          (i) => i.documentId !== documentId && !i.gone && (i.origin === "text" || i.origin === "computed") && same(i.value, f.value),
        );
        if (support.length === 0) return null;
        // a computation keeps the value whatever happens to the other pages; otherwise they must stay as they are
        if (!support.some((i) => i.origin === "computed")) reliesOn.push(...support.map((i) => i.documentId!));
      }
      return {
        url: doc.url,
        edit: { op: "gone" },
        expect: { document: "gone", events: [] },
        note: "every fact of the page is stated with the same value by another document or a computation: gone, no event (M5 rules, ruling M7-P26)",
        reliesOn,
      };
    },
  }));
}

/** Text bans a draft may append, with their sentence per language (`{name}`: the place as the page names it). */
const BAN_TEMPLATES = [
  { kind: "anchoring", de: "Ankern ist in {name} verboten.", en: "Anchoring is prohibited in {name}." },
  { kind: "fishing", de: "Angeln ist in {name} verboten.", en: "Fishing is prohibited in {name}." },
  { kind: "jet_ski", de: "Jetskis sind in {name} verboten.", en: "Jet skis are prohibited in {name}." },
] as const;

/**
 * The first name that occurs in the text as a whole word (M7-H-R1, M-5): not inside another word, Unicode letters
 * and digits count as word characters (Greek names too). Names are tried in the given order.
 */
export function nameInText(text: string, names: readonly string[]): string | undefined {
  return names.find((n) => n.trim() !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, "u").test(text));
}

/**
 * The change type an attribute gets when it takes a new value, as `detectChanges` decides it: `changed` when the
 * previous profile carries the attribute (value and provenance, even an empty list), else `new_attribute` (M7-H-R1, M-5).
 */
export function changeTypeOf(profile: ProfileSnapshot | undefined, attribute: string): ChangeType {
  return profile !== undefined && attribute in profile.attributes && profile.provenance[attribute] !== undefined ? "changed" : "new_attribute";
}

function banAppended(ctx: Context, names: Map<string, string[]>): Array<{ documentId: string; proposal: () => Proposal | null }> {
  const seen = new Set<string>();
  const out: Array<{ documentId: string; proposal: () => Proposal | null }> = [];
  for (const f of ctx.texts) {
    if (f.sourceType !== "authority" || !ctx.places.has(f.geoObjectId)) continue;
    const key = `${f.documentId}:${f.geoObjectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      documentId: f.documentId,
      proposal: () => {
        const doc = ctx.docs.get(f.documentId);
        if (!doc?.markdown) return null;
        const place = ctx.places.get(f.geoObjectId)!;
        const name = nameInText(doc.markdown, names.get(f.geoObjectId) ?? []);
        if (!name) return null;
        const profile = ctx.profiles.get(f.geoObjectId);
        const old = profile?.attributes.prohibitions;
        const list = Array.isArray(old) ? old : [];
        const ban = BAN_TEMPLATES.find((t) => !list.some((e) => isObject(e) && e.kind === t.kind));
        if (!ban) return null;
        const text = (german(doc) ? ban.de : ban.en).replace("{name}", name);
        const type = changeTypeOf(profile, "prohibitions");
        return {
          url: doc.url,
          edit: { op: "append", text },
          expect: { document: "new_version", events: [event(ctx, place, "prohibitions", type, old, [...list, { kind: ban.kind, months: null }])] },
          note: `${ban.kind} ban appended in an authority page: a safety list takes a new entry at once (M5-F-R3 I-3), ${type} prohibitions safety (ruling M7-P26)`,
        };
      },
    });
  }
  return out;
}

function buoysContradicted(ctx: Context): Array<{ documentId: string; proposal: () => Proposal | null }> {
  return ctx.texts
    .filter((f) => f.attribute === "mooring.buoys" && f.sourceType === "forum" && isObject(f.value) && typeof f.value.present === "boolean" && ctx.places.has(f.geoObjectId))
    .map((f) => ({
      documentId: f.documentId,
      proposal: () => {
        const place = ctx.places.get(f.geoObjectId)!;
        const present = (f.value as { present: boolean }).present;
        const old = ctx.profiles.get(f.geoObjectId)?.attributes["mooring.buoys"];
        if (!isObject(old) || old.present !== present) return null;
        if (inputsOf(ctx, f.geoObjectId, "mooring.buoys").some((i) => isObject(i.value) && i.value.present === !present)) return null;
        const editable = editableSentence(ctx, f);
        if (!editable) return null;
        const de = german(editable.doc);
        const to = present ? (de ? "Die Bojen wurden entfernt." : "The buoys have been removed.") : de ? "Bojen sind ausgelegt." : "Buoys have been laid.";
        if (to === editable.sentence) return null;
        return {
          url: editable.doc.url,
          edit: { op: "replace", from: editable.sentence, to },
          expect: { document: "new_version", events: [event(ctx, place, "mooring.buoys", "uncertain", old, { ...old, present: !present })] },
          note: `a forum (weight ${fmt(f.sourceWeight)}) alone contradicts mooring.buoys: neither ${ctx.cfg.change.minIndependent} independent sources nor a strong one, uncertain (M5-F-R3, ruling M7-P26)`,
        };
      },
    }));
}

function touch(ctx: Context): Array<{ documentId: string; proposal: () => Proposal | null }> {
  return [...ctx.docs.values()].map((doc) => ({
    documentId: doc.id,
    proposal: () => ({ url: doc.url, edit: { op: "touch" }, expect: { document: "unchanged", events: [] }, note: "fetched again unchanged: no event" }),
  }));
}

/**
 * Proposes a scenario of ten entries for a simulated revisit of the subdivision from the archive as it is now (see the module
 * comment), with `seed` choosing among the candidates of a kind. Runs against the simulation clone (the CLI refuses
 * anything else); reads only.
 */
export async function draftScenario(db: Db, archive: Archive, input: DraftInput): Promise<ScenarioDraft> {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const objects = await subdivisionObjectIds(db, input.subdivisionKey);
  const cfg = await consolidationConfigFor(db);
  const schemaVersion = getConfig().factSchema.version;

  const inputs = new Map<string, ConsolidationInput[]>();
  for (const id of objects) inputs.set(id, (await loadInputs(db, id, { cfg, schemaVersion, today })).inputs);

  const { rows: placeRows } = await db.execute<{ geo_object_id: string; public_id: string }>(sql`
    select p.geo_object_id, p.public_id from places p
    where p.status = 'confirmed' and p.public_id is not null and p.merged_into_id is null
      and p.geo_object_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(objects)}::jsonb))
  `);
  const places = new Map(placeRows.map((r) => [r.geo_object_id, { geoObjectId: r.geo_object_id, publicId: r.public_id }]));
  const profiles = await latestProfiles(db, [...places.keys()]);

  const textInputs = objects.flatMap((id) =>
    (inputs.get(id) ?? []).filter((i) => i.origin === "text" && i.factId && i.documentId && !i.gone).map((i) => ({ ...i, geoObjectId: id })),
  );
  const factIds = textInputs.map((i) => i.factId!);
  const { rows: quotes } = await db.execute<{ id: string; quote: string | null }>(sql`
    select id, quote from facts where id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(factIds)}::jsonb))
  `);
  const quoteOf = new Map(quotes.map((q) => [q.id, q.quote]));
  const texts: TextFact[] = textInputs
    .filter((i) => quoteOf.get(i.factId!))
    .map((i) => ({ ...i, factId: i.factId!, documentId: i.documentId!, quote: quoteOf.get(i.factId!)! }));

  const documentIds = [...new Set(texts.map((t) => t.documentId))];
  const { rows: docRows } = await db.execute<{ id: string; url: string; language: string | null; source_type: string; weight: number }>(sql`
    select d.id, d.url, v.language, s.type as source_type, s.weight
    from documents d join sources s on s.id = d.source_id left join document_versions v on v.id = d.current_version_id
    where d.status = 'active' and d.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(documentIds)}::jsonb))
    order by d.url, d.id
  `);
  const docs = new Map<string, Doc>();
  for (const r of docRows) {
    const base = await editBase(db, archive, r.id);
    docs.set(r.id, {
      id: r.id,
      url: r.url,
      language: r.language,
      sourceType: r.source_type,
      sourceWeight: Number(r.weight),
      markdown: base && !base.simulated ? base.markdown : null,
    });
  }

  // documents with facts on objects outside the subdivision: a 404 would change objects the verification does not see
  const { rows: outsideRows } = await db.execute<{ document_id: string }>(sql`
    select distinct v.document_id from facts f
    join mentions m on m.id = f.mention_id join document_versions v on v.id = m.document_version_id
    where v.document_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(documentIds)}::jsonb))
      and f.geo_object_id not in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(objects)}::jsonb))
  `);
  const outside = new Set(outsideRows.map((r) => r.document_id));

  const { rows: nameRows } = await db.execute<{ geo_object_id: string; name: string }>(sql`
    select geo_object_id, name from geo_names
    where geo_object_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify([...places.keys()])}::jsonb))
    order by geo_object_id, is_preferred desc, length(name) desc, name
  `);
  const names = new Map<string, string[]>();
  for (const r of nameRows) names.set(r.geo_object_id, [...(names.get(r.geo_object_id) ?? []), r.name]);

  const ctx: Context = { cfg, places, profiles, inputs, texts, docs };
  const candidates: Record<DraftKind, Array<{ documentId: string; proposal: () => Proposal | null }>> = {
    taverna_negated: tavernaNegated(ctx),
    taverna_deleted: tavernaDeleted(ctx),
    depth_changed: depthChanged(ctx),
    gone: gone(ctx, outside),
    ban_appended: banAppended(ctx, names),
    buoys_contradicted: buoysContradicted(ctx),
    touch: touch(ctx),
  };

  const random = prng(input.seed);
  const used = new Set<string>();
  const relied = new Set<string>();
  const entries: ScenarioEntry[] = [];
  const gaps: string[] = [];
  const name = `entwurf-${input.subdivisionKey}-seed-${input.seed}`;
  for (const { kind, count, label } of DRAFT_PLAN) {
    let found = 0;
    for (const candidate of shuffled(candidates[kind], random)) {
      if (found === count) break;
      if (used.has(candidate.documentId) || !docs.has(candidate.documentId)) continue;
      if (kind !== "touch" && relied.has(candidate.documentId)) continue;
      const proposal = candidate.proposal();
      if (!proposal) continue;
      const { reliesOn = [], ...rest } = proposal;
      // touch comes last: every used document so far is edited, deleted or gone
      if (reliesOn.some((id) => used.has(id))) continue;
      const entry: ScenarioEntry = { id: `e${entries.length + 1}`, ...rest };
      const [check] = await preflightScenario(db, archive, { name, entries: [entry] });
      if (!check?.ok) continue;
      used.add(candidate.documentId);
      for (const id of reliesOn) relied.add(id);
      entries.push(entry);
      found++;
    }
    if (found < count) gaps.push(`${label}: ${found} von ${count} gefunden – ${GAP_REASON[kind]}`);
  }
  return { scenario: { name, entries }, gaps };
}
