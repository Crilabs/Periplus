import { asc, eq, sql } from "drizzle-orm";
import type { ExtractRouteOutput, RouteLeg, RouteStop } from "@/lib/ai/tasks/extract-route";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, routes, routeStops } from "@/lib/db/schema";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { effectiveVersionMeta } from "@/lib/domain/mentions/classification";
import { plausibleDate } from "@/lib/domain/research/util/dates";
import { findNameHits, nameFormsOf } from "@/lib/domain/mentions/match";
import { nameForms } from "@/lib/domain/mentions/ngrams";
import { locateQuote } from "@/lib/domain/research/text/quote";
import { blockLateResults } from "./run-status";

/*
 * Routes of trip reports (spec 06): the stops of a voyage in order, each with a verbatim quote that the quote check
 * finds in a chunk of the version ("Ein Fact ohne wörtliches Zitat existiert nicht" holds for stops too), and the leg
 * to it only when its own quote is found. A stop gets the geo object the version mentions under its name, when exactly
 * one fits. Long reports are sent in sections (`routeSections`, `research/text`); their stops are joined in section order. Routes and
 * stops are append-only: one route per version and extraction run.
 */

/**
 * The geo object a stop name means among the objects this version mentions (its own mentions and those on the
 * origin chunks of chunks it carried over): an exact hit (also without a generic affix, "Kolona Bay" → Kolona) or one
 * with `similarity ≥ sureSimilarity`; exact hits win over similar ones. Exactly one object → it and one of its
 * mentions in the version (its own first, then by chunk and position); otherwise null.
 */
export async function assignStop(db: Db, versionId: string, name: string, cfg: AppConfig): Promise<{ geoObjectId: string; mentionId: string } | null> {
  const { rows: objects } = await db.execute<{ geo_object_id: string }>(sql`
    select distinct m.geo_object_id from mentions m
    where m.document_version_id = ${versionId}
      or m.chunk_id in (select c.carried_from_chunk_id from chunks c where c.document_version_id = ${versionId} and c.carried_from_chunk_id is not null)
  `);
  if (objects.length === 0) return null;
  const surface = name.trim();
  const forms = nameFormsOf(
    [{ start: 0, end: surface.length, surface, forms: nameForms(surface), words: surface.split(/\s+/).length }],
    { mentions: cfg.mentions, nameAffixes: cfg.nameAffixes },
  );
  const hits = (
    await findNameHits(
      db,
      forms,
      objects.map((o) => o.geo_object_id),
      { mentions: cfg.mentions, nameAffixes: cfg.nameAffixes },
    )
  ).filter((h) => h.exact || h.similarity >= cfg.mentions.sureSimilarity);
  const exact = new Set(hits.filter((h) => h.exact).map((h) => h.geoObjectId));
  const candidates = exact.size > 0 ? exact : new Set(hits.map((h) => h.geoObjectId));
  if (candidates.size !== 1) return null;
  const [geoObjectId] = [...candidates];
  const { rows } = await db.execute<{ id: string }>(sql`
    select m.id from mentions m join chunks c on c.id = m.chunk_id
    where m.geo_object_id = ${geoObjectId!}
      and (m.document_version_id = ${versionId}
        or m.chunk_id in (select c2.carried_from_chunk_id from chunks c2 where c2.document_version_id = ${versionId} and c2.carried_from_chunk_id is not null))
    order by (m.document_version_id = ${versionId}) desc, c.ordinal, m.char_start, m.id
    limit 1
  `);
  return rows[0] ? { geoObjectId: geoObjectId!, mentionId: rows[0].id } : null;
}

type VersionChunk = { id: string; text: string };

/** The first chunk of the version (by ordinal) whose text holds the quote; null when none does. */
function locateInVersion(quote: string, versionChunks: VersionChunk[], cfg: AppConfig["extraction"]["quote"]): VersionChunk | null {
  for (const chunk of versionChunks) if (locateQuote(chunk.text, quote, cfg).ok) return chunk;
  return null;
}

const nonNegative = (x: number | null) => (x !== null && Number.isFinite(x) && x >= 0 ? x : null);

/** The leg as stored, with its quote's chunk; null without a leg or without a quote the chunks hold. */
function storedLeg(leg: RouteLeg | null, versionChunks: VersionChunk[], cfg: AppConfig): Record<string, unknown> | null {
  if (!leg || leg.quote === null) return null;
  const chunk = locateInVersion(leg.quote, versionChunks, cfg.extraction.quote);
  if (!chunk) return null;
  const beaufort = leg.wind_beaufort;
  return {
    distance_nm: nonNegative(leg.distance_nm),
    duration_h: nonNegative(leg.duration_h),
    wind_direction: leg.wind_direction !== null && (SECTORS as readonly string[]).includes(leg.wind_direction) ? leg.wind_direction : null,
    wind_beaufort: beaufort !== null && Number.isInteger(beaufort) && beaufort >= 0 && beaufort <= cfg.extraction.routeStop.maxBeaufort ? beaufort : null,
    quote: leg.quote,
    quote_chunk_id: chunk.id,
  };
}

export type StoreRouteInput = { versionId: string; extractionRunId: string; sections: ExtractRouteOutput[] };

/**
 * Stores the route of a version from the answers of its sections, in section order: per section at most
 * `routeMaxStops` stops are looked at; a stop needs a name (≤ 80 characters) and a quote found in a chunk of the
 * version, else it is dropped; its leg stays only with a quote found too. Kept stops are numbered on from 0, dated only
 * with a plausible date, and assigned (`assignStop`). A route is stored only with at least one stop; idempotent per
 * (version, extraction run): a second call stores nothing and reports the stored route.
 */
export async function storeRoute(db: Db, input: StoreRouteInput, cfg: AppConfig): Promise<{ stops: number; dropped: number; assigned: number }> {
  const versionChunks = await db
    .select({ id: chunks.id, text: chunks.text })
    .from(chunks)
    .where(eq(chunks.documentVersionId, input.versionId))
    .orderBy(asc(chunks.ordinal));
  const meta = await effectiveVersionMeta(db, input.versionId);
  let dropped = 0;
  const kept: Array<{ stop: RouteStop; chunkId: string; leg: Record<string, unknown> | null }> = [];
  for (const section of input.sections) {
    const considered = section.stops.slice(0, cfg.extraction.routeMaxStops);
    dropped += section.stops.length - considered.length;
    for (const stop of considered) {
      const chunk = stop.name.trim().length > 0 && stop.name.length <= cfg.extraction.routeStop.nameMaxChars ? locateInVersion(stop.quote, versionChunks, cfg.extraction.quote) : null;
      if (!chunk) {
        dropped++;
        continue;
      }
      kept.push({ stop, chunkId: chunk.id, leg: storedLeg(stop.leg, versionChunks, cfg) });
    }
  }
  if (kept.length === 0) return { stops: 0, dropped, assigned: 0 };

  const [route] = await db
    .insert(routes)
    .values({ documentVersionId: input.versionId, extractionRunId: input.extractionRunId, stopsCount: kept.length })
    .onConflictDoNothing()
    .returning({ id: routes.id });
  if (!route) return storedRouteCounts(db, input, dropped);
  const rows = [];
  for (const [ordinal, k] of kept.entries()) {
    const assigned = await assignStop(db, input.versionId, k.stop.name, cfg);
    rows.push({
      routeId: route.id,
      ordinal,
      name: k.stop.name.trim(),
      geoObjectId: assigned?.geoObjectId ?? null,
      mentionId: assigned?.mentionId ?? null,
      date: plausibleDate(k.stop.date, meta.fetchedAt, cfg.extraction.earliestDate, false),
      mooring: k.stop.mooring,
      quote: k.stop.quote,
      quoteVerified: true,
      quoteChunkId: k.chunkId,
      leg: k.leg,
    });
  }
  await db.insert(routeStops).values(rows);
  // A route stored after the extraction run's check blocks the run until the check runs again (ruling M4-H-R3).
  await blockLateResults(db, input.extractionRunId);
  return { stops: rows.length, dropped, assigned: rows.filter((r) => r.geoObjectId !== null).length };
}

/** The counts of a route stored before (a repeated `storeRoute`). */
async function storedRouteCounts(db: Db, input: StoreRouteInput, dropped: number): Promise<{ stops: number; dropped: number; assigned: number }> {
  const { rows } = await db.execute<{ stops: number; assigned: number }>(sql`
    select count(s.id)::int as stops, count(s.geo_object_id)::int as assigned
    from routes r join route_stops s on s.route_id = r.id
    where r.document_version_id = ${input.versionId} and r.extraction_run_id = ${input.extractionRunId}
  `);
  return { stops: Number(rows[0]!.stops), dropped, assigned: Number(rows[0]!.assigned) };
}
