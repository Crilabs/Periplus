import { eq, sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { extractionRuns } from "@/lib/db/schema";
import { locateQuote } from "./quote";

/*
 * Belegtreue (spec 06, spec 10): "Anteil Facts mit `quote_verified = true` unter allen Text-Facts des Laufs; < 100 %
 * sperrt die Konsolidierung des Laufs". The stored flag cannot be false (database check), so the control does not
 * trust it: every text fact of an extraction run is checked again against the text of its quote chunk, and the span
 * the quote check finds must be the stored span. Route stops (and the quote of their leg) are checked the same way
 * against their chunk. The result goes to `extraction_runs.quote_check`; a run below 100 % is `blocked` and never the
 * active run of a version (`activeExtractionRun`), so M5 never consolidates its facts.
 */

export type FidelityFailure = {
  /** The fact or route stop. */
  factId: string;
  kind: "fact" | "route_stop" | "route_leg";
  /** `not_verified`, `no_chunk`, `offset_mismatch` or a quote check reason (`not_found`, `too_long` …). */
  reason: string;
};

/** Checked items (text facts and route stops), those that verify, their share (1 without any) and the failures. */
export type QuoteFidelity = { facts: number; verified: number; ratio: number; failures: FidelityFailure[] };

type Located = { quote: string; text: string | null; start?: number | null; end?: number | null };

/** Why a stored quote does not hold up against its chunk, or null when it does. */
function quoteFailure(item: Located, cfg: AppConfig["extraction"]["quote"]): string | null {
  if (item.text === null) return "no_chunk";
  const hit = locateQuote(item.text, item.quote, cfg);
  if (!hit.ok) return hit.reason;
  if (item.start !== undefined && (hit.start !== item.start || hit.end !== item.end)) return "offset_mismatch";
  return null;
}

const shareOf = (verified: number, total: number) => (total === 0 ? 1 : Number((verified / total).toFixed(6)));

type StoredLeg = { quote?: unknown; quote_chunk_id?: unknown } | null;

/**
 * Checks every text fact and route stop of the extraction run again (whatever its stored flag says) and records the
 * result: `quote_check`, status `blocked` when the share is below 1, else `finished`, and `finished_at`. Idempotent:
 * a repeated check writes the same result.
 */
export async function checkQuoteFidelity(db: Db, extractionRunId: string, cfg: AppConfig): Promise<QuoteFidelity> {
  const quoteCfg = cfg.extraction.quote;
  const failures: FidelityFailure[] = [];
  let total = 0;

  const { rows: factRows } = await db.execute<{
    id: string;
    quote: string | null;
    quote_verified: boolean;
    quote_start: number | null;
    quote_end: number | null;
    text: string | null;
  }>(sql`
    select f.id, f.quote, f.quote_verified, f.quote_start, f.quote_end, c.text
    from facts f left join chunks c on c.id = f.quote_chunk_id
    where f.extraction_run_id = ${extractionRunId} and f.mention_id is not null
    order by f.id
  `);
  for (const f of factRows) {
    total++;
    const reason = !f.quote_verified
      ? "not_verified"
      : quoteFailure({ quote: f.quote ?? "", text: f.text, start: f.quote_start, end: f.quote_end }, quoteCfg);
    if (reason) failures.push({ factId: f.id, kind: "fact", reason });
  }

  const { rows: stopRows } = await db.execute<{ id: string; quote: string; quote_verified: boolean; text: string | null; leg: StoredLeg; leg_text: string | null }>(sql`
    select s.id, s.quote, s.quote_verified, c.text, s.leg, lc.text as leg_text
    from route_stops s
    join routes r on r.id = s.route_id
    left join chunks c on c.id = s.quote_chunk_id
    left join chunks lc on s.leg ? 'quote_chunk_id' and jsonb_typeof(s.leg -> 'quote_chunk_id') = 'string'
      and lc.id::text = s.leg ->> 'quote_chunk_id'
    where r.extraction_run_id = ${extractionRunId}
    order by r.id, s.ordinal
  `);
  for (const s of stopRows) {
    total++;
    const stopReason = !s.quote_verified ? "not_verified" : quoteFailure({ quote: s.quote, text: s.text }, quoteCfg);
    if (stopReason) {
      failures.push({ factId: s.id, kind: "route_stop", reason: stopReason });
      continue;
    }
    // A leg is stored only with its own verified quote; one that does not hold up fails its stop.
    if (s.leg !== null) {
      const legReason = typeof s.leg.quote !== "string" ? "not_verified" : quoteFailure({ quote: s.leg.quote, text: s.leg_text }, quoteCfg);
      if (legReason) failures.push({ factId: s.id, kind: "route_leg", reason: legReason });
    }
  }

  const verified = total - failures.length;
  const result: QuoteFidelity = { facts: total, verified, ratio: shareOf(verified, total), failures };
  await db
    .update(extractionRuns)
    .set({ quoteCheck: result, status: result.ratio < 1 ? "blocked" : "finished", finishedAt: sql`now()` })
    .where(eq(extractionRuns.id, extractionRunId));
  return result;
}

/**
 * Belegtreue of a run (spec 10) over all its extraction runs: the checked items and those that verified, from the
 * recorded control (`quote_check`); an extraction run not checked yet counts its text facts by their stored flag.
 */
export async function belegtreue(db: Db, runId: string): Promise<{ facts: number; verified: number; ratio: number }> {
  const { rows } = await db.execute<{ facts: number; verified: number }>(sql`
    select coalesce(sum(n.facts), 0)::int as facts, coalesce(sum(n.verified), 0)::int as verified
    from extraction_runs r
    cross join lateral (
      select (r.quote_check ->> 'facts')::int as facts, (r.quote_check ->> 'verified')::int as verified
      where r.quote_check is not null
      union all
      select count(*)::int, count(*) filter (where f.quote_verified)::int
      from facts f
      where r.quote_check is null and f.extraction_run_id = r.id and f.mention_id is not null
    ) n
    where r.run_id = ${runId}
  `);
  const facts = Number(rows[0]!.facts);
  const verified = Number(rows[0]!.verified);
  return { facts, verified, ratio: shareOf(verified, facts) };
}
