import { eq, sql } from "drizzle-orm";
import type { HttpCallDeps, Transport } from "@/lib/adapters/http";
import { searchNominatim, type NominatimHit } from "@/lib/adapters/nominatim";
import { simulationActive } from "@/lib/adapters/simulation";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { nameCandidates, runs } from "@/lib/db/schema";
import { jsonUuids } from "@/lib/domain/research/util/json-uuids";
import { createReviewTask, hasDecidedTask, openTaskFor } from "@/lib/domain/review";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import { frozenRunVersions } from "./versions";

/*
 * Stage `mentions.geocode` (spec 06, new names): "Ein Name in ≥ 2 Dokumenten verschiedener Quellen →
 * Nominatim-Umkreissuche (20 km um die Kachel) → Review-Aufgabe place_candidate". The place hints without a gazetteer
 * hit (`unmatched_names`, written by `mentions.batch`) are grouped per (name, tile); a group seen in enough documents
 * of enough sources becomes a `name_candidates` row, is searched once in Nominatim and opened as a review task
 * (`place_candidate` on a `name_candidate`). The stage plans from the run's frozen version set (ruling M4-E-R2): only
 * groups with a hint in one of the run's versions, counted over all their hints.
 */

export const GEOCODE_STAGE = "mentions.geocode";
export const GEOCODE_QUEUE = "mentions.geocode" as const;

/** Nominatim hits and text occurrences the review task carries. */
export const TASK_HITS = 5;
export const TASK_OCCURRENCES = 10;
/** Characters of chunk text before and after the name in an occurrence snippet. */
export const SNIPPET_CHARS = 150;

/** Where a candidate's name stands in a text: `start`/`end` are offsets into `snippet`. */
export type NameOccurrence = {
  documentId: string;
  versionId: string;
  chunkId: string;
  snippet: string;
  start: number;
  end: number;
};

/** The context of a `place_candidate` task on a `name_candidate`. */
export type NameCandidateContext = {
  name: string;
  hint: string | null;
  tileId: string;
  hits: NominatimHit[];
  occurrences: NameOccurrence[];
};

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.text.geocode"));

type Group = { name_normalized: string; tile_id: string; display_name: string; hint: string | null; documents: number; sources: number };

/** The normalized forms under which the gazetteer would know the name: itself and with every configured affix. */
function gazetteerForms(name: string, cfg: AppConfig): string[] {
  return [name, ...cfg.nameAffixes.map((a) => (a.position === "prefix" ? `${a.affix} ${name}` : `${name} ${a.affix}`))];
}

/** Names of `names` that a valid, unmerged gazetteer object carries, as such or with an affix. */
async function knownNames(db: Db, names: string[], cfg: AppConfig): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const forms = names.flatMap((name) => gazetteerForms(name, cfg).map((form) => ({ name, form })));
  const { rows } = await db.execute<{ name: string }>(sql`
    select distinct f.name
    from jsonb_to_recordset(${JSON.stringify(forms)}::jsonb) as f(name text, form text)
    join geo_names gn on gn.name_normalized = f.form and gn.valid_to is null
    join geo_objects o on o.id = gn.geo_object_id and o.valid_to is null and o.merged_into_id is null
  `);
  return new Set(rows.map((r) => r.name));
}

/**
 * The name groups of the run: every (name, tile) of `unmatched_names` with a hint in one of the run's frozen versions,
 * counted over all its hints (documents and source domains distinct), with ≥ `minDocuments` documents from ≥
 * `minSources` sources ("verschiedener Quellen": registrable domains, so an ended and re-created source of one domain
 * counts once). A name the gazetteer knows anywhere (outside the version's candidate space, or added since) is logged and
 * left out. The groups are upserted into `name_candidates` (counters updated); returned are the candidates still
 * `collecting` without a decided task. Touches no review task while it holds candidate rows (ruling M4-P14).
 */
export async function collectNameCandidates(db: Db, runId: string, cfg: AppConfig = getConfig()): Promise<string[]> {
  const [run] = await db.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  const versionIds = await frozenRunVersions(db, run.params as Record<string, unknown>);
  if (versionIds.length === 0) return [];
  const { minDocuments, minSources } = cfg.extraction.geocode;

  const { rows: groups } = await db.execute<Group>(sql`
    with own as (
      select distinct u.name_normalized, u.tile_id from unmatched_names u
      where u.document_version_id in ${jsonUuids(versionIds)} and u.tile_id is not null
    )
    select u.name_normalized, u.tile_id,
           mode() within group (order by u.display_name) as display_name,
           mode() within group (order by u.hint) filter (where u.hint is not null) as hint,
           count(distinct v.document_id)::int as documents,
           count(distinct s.domain)::int as sources
    from unmatched_names u
    join own on own.name_normalized = u.name_normalized and own.tile_id = u.tile_id
    join document_versions v on v.id = u.document_version_id
    join sources s on s.id = u.source_id
    group by u.name_normalized, u.tile_id
    having count(distinct v.document_id) >= ${minDocuments} and count(distinct s.domain) >= ${minSources}
    order by u.name_normalized, u.tile_id
  `);
  const known = await knownNames(db, [...new Set(groups.map((g) => g.name_normalized))], cfg);
  for (const g of groups.filter((g) => known.has(g.name_normalized))) {
    getLog().info({ name: g.name_normalized, tileId: g.tile_id, documents: g.documents, runId }, "unmatched name is in the gazetteer outside the candidate space");
  }
  const fresh = groups.filter((g) => !known.has(g.name_normalized));
  if (fresh.length === 0) return [];

  const upserted = await db
    .insert(nameCandidates)
    .values(
      fresh.map((g) => ({
        nameNormalized: g.name_normalized,
        displayName: g.display_name,
        hint: g.hint,
        tileId: g.tile_id,
        documents: g.documents,
        sources: g.sources,
      })),
    )
    .onConflictDoUpdate({
      target: [nameCandidates.nameNormalized, nameCandidates.tileId],
      set: { documents: sql`excluded.documents`, sources: sql`excluded.sources` },
    })
    .returning({ id: nameCandidates.id, status: nameCandidates.status });

  const ids: string[] = [];
  for (const c of upserted.filter((c) => c.status === "collecting")) {
    if (!(await hasDecidedTask(db, "place_candidate", c.id))) ids.push(c.id);
  }
  return ids.sort();
}

/** The name in the chunk text with up to `chars` characters around it; offsets into the snippet. */
export function occurrenceSnippet(text: string, name: string, chars = SNIPPET_CHARS): { snippet: string; start: number; end: number } {
  let at = text.indexOf(name);
  if (at < 0) at = text.toLowerCase().indexOf(name.toLowerCase());
  if (at < 0) return { snippet: text.slice(0, 2 * chars), start: 0, end: 0 };
  const from = Math.max(0, at - chars);
  const to = Math.min(text.length, at + name.length + chars);
  return { snippet: text.slice(from, to), start: at - from, end: at - from + name.length };
}

/** One occurrence per document (its newest version with the name), newest documents first, at most `TASK_OCCURRENCES`. */
async function occurrencesOf(db: Db, nameNormalized: string, tileId: string): Promise<NameOccurrence[]> {
  const { rows } = await db.execute<{
    document_id: string;
    version_id: string;
    chunk_id: string;
    display_name: string;
    text: string;
    fetched_at: Date;
  }>(sql`
    select * from (
      select distinct on (v.document_id) v.document_id, v.id as version_id, u.chunk_id, u.display_name, c.text, v.fetched_at
      from unmatched_names u
      join document_versions v on v.id = u.document_version_id
      join chunks c on c.id = u.chunk_id
      where u.name_normalized = ${nameNormalized} and u.tile_id = ${tileId}
      order by v.document_id, v.fetched_at desc, c.ordinal, u.id
    ) o
    order by o.fetched_at desc, o.document_id
    limit ${TASK_OCCURRENCES}
  `);
  return rows.map((r) => ({
    documentId: r.document_id,
    versionId: r.version_id,
    chunkId: r.chunk_id,
    ...occurrenceSnippet(r.text, r.display_name),
  }));
}

class CandidateDecided extends Error {}

/**
 * Geocodes one name candidate and opens its review task: a Nominatim radius search for the display name around the
 * candidate's tile (outside any transaction), then in one transaction the task (`place_candidate`, subject
 * `name_candidate`, context `NameCandidateContext`, priority = documents) first and the candidate row second (ruling
 * M4-P14: review-task row before subject row): `geocode` = the hits, status `review`. Without a hit the task opens all
 * the same (the reviewer sets the position by a click). A candidate already in review returns its open task without a
 * new request; a decided one (or one with a decided task) returns null.
 */
export async function geocodeCandidate(
  db: Db,
  candidateId: string,
  deps: { transport: Transport; http?: HttpCallDeps },
  ctx: { runId?: string | null; cfg?: AppConfig } = {},
): Promise<{ hits: number; taskId: string } | null> {
  const cfg = ctx.cfg ?? getConfig();
  const [candidate] = await db.select().from(nameCandidates).where(eq(nameCandidates.id, candidateId));
  if (!candidate) throw new Error(`name candidate ${candidateId} not found`);
  if (candidate.status === "decided" || (await hasDecidedTask(db, "place_candidate", candidate.id))) return null;
  if (candidate.status === "review") {
    const open = await openTaskFor(db, "place_candidate", candidate.id);
    if (open) return { hits: Array.isArray(candidate.geocode) ? candidate.geocode.length : 0, taskId: open.id };
  }

  const { geocode } = cfg.extraction;
  const hits = await searchNominatim(
    deps.transport,
    { query: candidate.displayName, tileId: candidate.tileId, radiusKm: geocode.radiusKm, limit: geocode.limit },
    { db, runId: ctx.runId ?? undefined, tileId: candidate.tileId, stage: GEOCODE_STAGE },
    geocode,
    deps.http,
  );
  const occurrences = await occurrencesOf(db, candidate.nameNormalized, candidate.tileId);
  const context: NameCandidateContext = {
    name: candidate.displayName,
    hint: candidate.hint,
    tileId: candidate.tileId,
    hits: hits.slice(0, TASK_HITS),
    occurrences,
  };

  try {
    return await db.transaction(async (tx) => {
      const task = await createReviewTask(tx, {
        kind: "place_candidate",
        subjectType: "name_candidate",
        subjectId: candidate.id,
        context,
        priority: candidate.documents,
      });
      const [locked] = await tx
        .select({ status: nameCandidates.status })
        .from(nameCandidates)
        .where(eq(nameCandidates.id, candidate.id))
        .for("update");
      // Decided while Nominatim answered: drop the task just opened.
      if (!locked || locked.status === "decided") throw new CandidateDecided();
      await tx.update(nameCandidates).set({ geocode: hits, status: "review" }).where(eq(nameCandidates.id, candidate.id));
      return { hits: hits.length, taskId: task.id };
    });
  } catch (error) {
    if (error instanceof CandidateDecided) return null;
    throw error;
  }
}

/**
 * Plan of the stage: one job per name candidate to geocode (`{ key, candidateId }`). A simulated revisit plans none
 * (ruling M7-P8): Nominatim is a third-party service the simulation never reaches, so the clone collects no candidates.
 */
export async function planGeocode(db: Db, run: { id: string }, cfg: AppConfig = getConfig()): Promise<JobData[]> {
  if (simulationActive()) return [];
  const ids = await collectNameCandidates(db, run.id, cfg);
  return ids.map((candidateId) => ({ key: `geocode:${candidateId}`, candidateId }));
}
