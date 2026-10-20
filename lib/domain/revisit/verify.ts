import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import type { ChangeSeverity, ChangeType } from "@/lib/db/schema";
import { visibleChangeEventsFilter } from "@/lib/domain/change-feed";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { subdivisionObjectIds } from "./scope";
import { scenarioUrlKey, type ExpectedEvent, type RevisitScenario } from "./scenario";

/*
 * Verification of a simulated revisit (spec 10, plan Task 13): the change feed of the subdivision since the clone against the
 * scenario's expectations („genau diese Änderungen und nichts anderes“), and the asOf check of the API.
 */

/** A change event of the subdivision the scenario did not expect (or one more than it expected). */
export type UnexpectedEvent = {
  seq: number;
  subject: string | null;
  attribute: string | null;
  type: ChangeType;
  severity: ChangeSeverity;
  oldValue: unknown;
  newValue: unknown;
};

export type RevisitVerification = {
  fromSeq: number;
  entries: Array<{
    id: string;
    url: string;
    document: { expected: string; actual: "new_version" | "gone" | "unchanged" };
    events: { expected: number; matched: number };
    ok: boolean;
  }>;
  /** Scenario entries. */
  expected: number;
  /** Entries whose document outcome and every expected event were found. */
  correct: number;
  unexpected: UnexpectedEvent[];
  passes: boolean;
};

type EventRow = UnexpectedEvent;

/**
 * Whether an expected attribute matches the event's: equal, both null, or `<prefix>.*` for any attribute under the
 * prefix (`depth.*` matches `depth.min`, never `draft` or `depth` itself).
 */
export function attributeMatches(expected: string | null, actual: string | null): boolean {
  if (expected === null || actual === null) return expected === actual;
  if (expected.endsWith(".*")) return actual.startsWith(expected.slice(0, -1));
  return expected === actual;
}

const matches = (e: ExpectedEvent, row: EventRow) =>
  row.subject === e.subject && attributeMatches(e.attribute, row.attribute) && row.type === e.type && row.severity === e.severity;

/**
 * The change events after `fromSeq` of the subdivision's geo objects (`subdivisionObjectIds`: its own object, every
 * object of its scope tiles and the places on them), with the subject's public id (the place's `sp_` id, else the
 * object's `ar_`/`rg_`/`hl_` id). Read with the change feed's outbox guard (`visibleChangeEventsFilter`,
 * ruling M5-A-R2): only rows of transactions no longer in flight, plus the reader's own (a verification inside the
 * writing transaction, tests).
 */
async function subdivisionEvents(db: Db, subdivisionKey: string, fromSeq: number): Promise<EventRow[]> {
  const objectIds = JSON.stringify(await subdivisionObjectIds(db, subdivisionKey));
  const { rows } = await db.execute<{
    seq: string | number;
    subject: string | null;
    attribute: string | null;
    type: ChangeType;
    severity: ChangeSeverity;
    old_value: unknown;
    new_value: unknown;
  }>(sql`
    with objects as (
      select value::uuid as id from jsonb_array_elements_text(${objectIds}::jsonb)
    )
    select change_events.seq, change_events.attribute, change_events.type, change_events.severity,
      change_events.old_value, change_events.new_value,
      coalesce(
        (select p.public_id from places p where p.geo_object_id = change_events.geo_object_id and p.public_id is not null order by p.created_at, p.id limit 1),
        o.public_id
      ) as subject
    from change_events
    join geo_objects o on o.id = change_events.geo_object_id
    where change_events.seq > ${fromSeq} and change_events.geo_object_id in (select id from objects)
      and (${visibleChangeEventsFilter()} or change_events.xact_id = pg_current_xact_id_if_assigned())
    order by change_events.seq
  `);
  return rows.map((r) => ({
    seq: Number(r.seq),
    subject: r.subject,
    attribute: r.attribute,
    type: r.type,
    severity: r.severity,
    oldValue: r.old_value,
    newValue: r.new_value,
  }));
}

/**
 * What the revisit did to the entry's page: `gone` when the document is gone, `new_version` when it has a simulated
 * version written by a run of kind `revisit`, else `unchanged` (also for a URL without a document).
 */
async function documentOutcome(db: Db, url: string): Promise<"new_version" | "gone" | "unchanged"> {
  const { rows } = await db.execute<{ status: string; simulated: boolean }>(sql`
    select d.status::text as status, exists (
      select 1 from document_versions v join runs r on r.id = v.run_id
      where v.document_id = d.id and v.simulated and r.kind = 'revisit'
    ) as simulated
    from documents d where d.url_normalized = ${scenarioUrlKey(url)}
  `);
  const doc = rows[0];
  if (!doc) return "unchanged";
  if (doc.status === "gone") return "gone";
  return doc.simulated ? "new_version" : "unchanged";
}

/**
 * Compares the subdivision's change events after `fromSeq` (`subdivisionEvents`) with the scenario: per entry the document outcome
 * (`documentOutcome`) and each expected event — same subject (public id), attribute equal or under a `.*` prefix, same
 * type and severity. Exact attributes are matched before `.*` prefixes, each pass in scenario order and events in `seq`
 * order; an event satisfies at most one expectation, so a second event of the same kind is unexpected, as is every event no expectation took (also `expired`
 * ones: „nichts anderes“, ruling M7-P7). `passes` = every entry correct and nothing unexpected.
 */
export async function verifyRevisit(db: Db, scenario: RevisitScenario, opts: { fromSeq: number; subdivisionKey: string }): Promise<RevisitVerification> {
  const events = await subdivisionEvents(db, opts.subdivisionKey, opts.fromSeq);
  const used = new Set<number>();
  const matchedOf = new Map<string, number>(scenario.entries.map((e) => [e.id, 0]));
  // exact attributes first, `.*` prefixes after: a prefix never takes the event an exact expectation needs
  for (const wildcard of [false, true]) {
    for (const entry of scenario.entries) {
      for (const expected of entry.expect.events) {
        if ((expected.attribute?.endsWith(".*") ?? false) !== wildcard) continue;
        const hit = events.find((row) => !used.has(row.seq) && matches(expected, row));
        if (!hit) continue;
        used.add(hit.seq);
        matchedOf.set(entry.id, matchedOf.get(entry.id)! + 1);
      }
    }
  }
  const entries: RevisitVerification["entries"] = [];
  for (const entry of scenario.entries) {
    const matched = matchedOf.get(entry.id)!;
    const actual = await documentOutcome(db, entry.url);
    const expectedCount = entry.expect.events.length;
    entries.push({
      id: entry.id,
      url: entry.url,
      document: { expected: entry.expect.document, actual },
      events: { expected: expectedCount, matched },
      ok: actual === entry.expect.document && matched === expectedCount,
    });
  }
  const unexpected = events.filter((row) => !used.has(row.seq));
  const correct = entries.filter((e) => e.ok).length;
  return {
    fromSeq: opts.fromSeq,
    entries,
    expected: entries.length,
    correct,
    unexpected,
    passes: correct === entries.length && unexpected.length === 0,
  };
}

/** `sim_meta` of a simulation database (`scripts/sim/clone.sh`, plan Task 15): when and from where it was cloned. */
export type SimMeta = { clonedAt: Date; sourceDb: string; fromSeq: number };

/** The newest `sim_meta` row; null where the table does not exist (every database but a simulation clone) or is empty. */
export async function readSimMeta(db: Db): Promise<SimMeta | null> {
  const { rows: present } = await db.execute<{ present: boolean }>(sql`select to_regclass('public.sim_meta') is not null as present`);
  if (!present[0]?.present) return null;
  const { rows } = await db.execute<{ cloned_at: Date | string; source_db: string; from_seq: string | number }>(
    sql`select cloned_at, source_db, from_seq from sim_meta order by cloned_at desc limit 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return { clonedAt: new Date(row.cloned_at), sourceDb: row.source_db, fromSeq: Number(row.from_seq) };
}

type DeliveryPoint = { dataVersion: number; generatedAt: Date };

export type AsOfPlan = { asOf: string; before: DeliveryPoint; after: DeliveryPoint } | { reason: string };

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The asOf check of a revisit (spec 10 „GET /spots/{id}?asOf=<Datum vor Revisit> liefert die alte Version“): the latest
 * valid package of the subdivision built before the first revisit run (in a simulation clone: the first one started after the
 * clone) and the FIRST one built after it (ruling M7-G-R3: a later package would let asOf land on a post-revisit state);
 * `asOf` = the UTC day before that first package was built. Packages are dated by UTC day, so a package built on the
 * same day as that one cannot be told apart from it.
 */
export async function asOfPlan(db: Db, subdivisionKey: string): Promise<AsOfPlan> {
  const meta = await readSimMeta(db);
  const { rows: revisits } = await db.execute<{ created_at: Date | string }>(sql`
    select created_at from runs
    where kind = 'revisit' and scope_type = 'subdivision' and scope_id = ${subdivisionKey}
      ${meta ? sql`and created_at >= ${meta.clonedAt.toISOString()}::timestamptz` : sql``}
    order by created_at, id limit 1
  `);
  if (!revisits[0]) return { reason: "Kein Revisit-Lauf für den Landesteil" };
  const revisitAt = new Date(revisits[0].created_at).toISOString();
  const around = async (side: "before" | "after"): Promise<DeliveryPoint | null> => {
    const { rows } = await db.execute<{ data_version: number; generated_at: Date | string }>(sql`
      select d.data_version, d.generated_at
      -- TODO(plan 14a task 10): deliveries are per subdivision then (deliveries.subdivision_id); until then by area key
      from deliveries d join geo_objects a on a.id = d.area_id and a.type = 'area' and a.config_key = ${subdivisionKey}
      where d.status = 'valid'
        and ${side === "before" ? sql`d.generated_at < ${revisitAt}::timestamptz` : sql`d.generated_at > ${revisitAt}::timestamptz`}
      order by d.data_version ${side === "before" ? sql`desc` : sql`asc`} limit 1
    `);
    return rows[0] ? { dataVersion: Number(rows[0].data_version), generatedAt: new Date(rows[0].generated_at) } : null;
  };
  const before = await around("before");
  if (!before) return { reason: "Vor dem Revisit kein Paket gebaut" };
  const after = await around("after");
  if (!after) return { reason: "Nach dem Revisit kein Paket gebaut" };
  if (utcDay(before.generatedAt) === utcDay(after.generatedAt)) {
    return { reason: "Paket vor dem Revisit am selben Tag gebaut – asOf kann die Stände nicht trennen" };
  }
  const asOf = utcDay(new Date(Date.parse(`${utcDay(after.generatedAt)}T00:00:00Z`) - 86_400_000));
  return { asOf, before, after };
}

export type AsOfCheck = { ok: boolean; status: number; dataVersion: number | null; reason?: string };

/**
 * `GET <baseUrl>/api/v1/spots/<spotId>[?asOf=<asOf>]` with the API key (never logged or returned): ok when the API
 * answers 200 with `expect.dataVersion` and, when given, `expect.spot` (compared as canonical JSON: the value, not only
 * its number, ruling M7-G-R3). `label` names the expected state in the reason. A network error is status 0.
 */
async function checkSpotApi(input: {
  baseUrl: string;
  key: string;
  spotId: string;
  asOf?: string;
  expect: { dataVersion: number; spot?: unknown };
  label: string;
  fetch?: typeof fetch;
}): Promise<AsOfCheck> {
  const doFetch = input.fetch ?? fetch;
  const query = input.asOf === undefined ? "" : `?asOf=${encodeURIComponent(input.asOf)}`;
  const url = `${input.baseUrl.replace(/\/+$/, "")}/api/v1/spots/${encodeURIComponent(input.spotId)}${query}`;
  let res: Response;
  try {
    res = await doFetch(url, { headers: { Authorization: `Bearer ${input.key}`, Accept: "application/json" } });
  } catch (error) {
    return { ok: false, status: 0, dataVersion: null, reason: `API nicht erreichbar: ${(error as Error).message}` };
  }
  if (res.status !== 200) return { ok: false, status: res.status, dataVersion: null, reason: `HTTP ${res.status}` };
  let dataVersion: number | null = null;
  let spot: unknown;
  try {
    const body = (await res.json()) as { dataVersion?: unknown; spot?: unknown };
    dataVersion = typeof body.dataVersion === "number" ? body.dataVersion : null;
    spot = body.spot;
  } catch {
    return { ok: false, status: res.status, dataVersion: null, reason: "Antwort ist kein JSON" };
  }
  if (dataVersion !== input.expect.dataVersion) {
    return { ok: false, status: res.status, dataVersion, reason: `Datenversion ${dataVersion ?? "fehlt"} statt ${input.expect.dataVersion} (${input.label})` };
  }
  if (input.expect.spot !== undefined && (spot === undefined || canonicalJson(spot) !== canonicalJson(input.expect.spot))) {
    return { ok: false, status: res.status, dataVersion, reason: `Spot weicht vom ${input.label} ab` };
  }
  return { ok: true, status: res.status, dataVersion };
}

/**
 * `GET <baseUrl>/api/v1/spots/<spotId>?asOf=<asOf>` with the API key (never logged or returned): ok when the API
 * answers 200 with the data version the spot had before the revisit (`expectBefore.dataVersion`) and, when given, the
 * spot as it was delivered then (`expectBefore.spot`, compared as canonical JSON: the old value, not only its number,
 * ruling M7-G-R3). A network error is status 0.
 */
export function checkAsOf(input: {
  baseUrl: string;
  key: string;
  spotId: string;
  asOf: string;
  expectBefore: { dataVersion: number; spot?: unknown };
  fetch?: typeof fetch;
}): Promise<AsOfCheck> {
  return checkSpotApi({ ...input, expect: input.expectBefore, label: "Stand vor dem Revisit" });
}

/**
 * `GET <baseUrl>/api/v1/spots/<spotId>` (no asOf): ok when the API answers the spot's newest delivered state of the
 * simulation clone (`expectCurrent`, a package built only in the simulation after the revisit). A web on another
 * database answers another state, so this tells the simulation web apart from the development or production web
 * (final review A M-4).
 */
export function checkCurrentSpot(input: {
  baseUrl: string;
  key: string;
  spotId: string;
  expectCurrent: { dataVersion: number; spot: unknown };
  fetch?: typeof fetch;
}): Promise<AsOfCheck> {
  return checkSpotApi({ ...input, expect: input.expectCurrent, label: "Stand der Simulation nach dem Revisit" });
}
