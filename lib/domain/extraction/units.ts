import { sql } from "drizzle-orm";
import type { ExtractionConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { levelFor } from "@/lib/domain/facts/levels";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { jsonUuids } from "@/lib/domain/mentions/scope";

/*
 * Extraction units (spec 06): "Einheit je (Dokumentversion, Geo-Objekt) mit Nachbar-Chunks". A unit holds the chunks
 * of the object's mentions in one version plus `neighbourChunks` chunks on each side (by ordinal, same version); a
 * group of more than `maxChunksPerUnit` chunks is cut into parts of at most that many chunks, so a model request stays
 * bounded. Neighbouring parts share the chunks at their boundary (2 × `neighbourChunks`), so no mention loses its
 * neighbour context to a cut. A mention of an object that takes no facts (`levelFor` null: a settlement without a place) is skipped.
 */

export type ExtractionUnitDraft = {
  documentVersionId: string;
  geoObjectId: string;
  part: number;
  level: FactLevel;
  /** The mentions of the object in the part's chunks, in text order. */
  mentionIds: string[];
  /** The part's chunks, by ordinal. */
  chunkIds: string[];
};

type MentionRow = { id: string; version_id: string; geo_object_id: string; ordinal: number; char_start: number };
type ChunkRow = { id: string; version_id: string; ordinal: number };

/**
 * Groups the given mentions into extraction units per (version, object), in version and object id order; returns the
 * units and the ids of the skipped mentions (object without a fact level). A part without a mention of its own (only
 * possible with wide neighbour rings) is left out; parts are numbered from 0 in text order.
 */
export async function planUnits(
  db: Db,
  mentionIds: string[],
  cfg: ExtractionConfig["unit"],
): Promise<{ units: ExtractionUnitDraft[]; skipped: string[] }> {
  if (mentionIds.length === 0) return { units: [], skipped: [] };
  const { rows: mentionRows } = await db.execute<MentionRow>(sql`
    select m.id, m.document_version_id as version_id, m.geo_object_id, c.ordinal, m.char_start
    from mentions m join chunks c on c.id = m.chunk_id
    where m.id in ${jsonUuids(mentionIds)}
    order by m.document_version_id, m.geo_object_id, c.ordinal, m.char_start, m.id
  `);
  const versionIds = [...new Set(mentionRows.map((m) => m.version_id))];
  const { rows: chunkRows } =
    versionIds.length === 0
      ? { rows: [] as ChunkRow[] }
      : await db.execute<ChunkRow>(sql`
          select c.id, c.document_version_id as version_id, c.ordinal from chunks c
          where c.document_version_id in ${jsonUuids(versionIds)}
          order by c.document_version_id, c.ordinal
        `);
  const chunksByVersion = new Map<string, Map<number, string>>();
  for (const c of chunkRows) {
    const byOrdinal = chunksByVersion.get(c.version_id) ?? new Map<number, string>();
    byOrdinal.set(c.ordinal, c.id);
    chunksByVersion.set(c.version_id, byOrdinal);
  }

  const groups = new Map<string, MentionRow[]>();
  for (const m of mentionRows) {
    const key = `${m.version_id}:${m.geo_object_id}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }

  const levels = new Map<string, FactLevel | null>();
  const units: ExtractionUnitDraft[] = [];
  const skipped: string[] = [];
  for (const group of groups.values()) {
    const { version_id: versionId, geo_object_id: geoObjectId } = group[0]!;
    if (!levels.has(geoObjectId)) levels.set(geoObjectId, await levelFor(db, geoObjectId));
    const level = levels.get(geoObjectId) ?? null;
    if (level === null) {
      skipped.push(...group.map((m) => m.id));
      continue;
    }
    const byOrdinal = chunksByVersion.get(versionId) ?? new Map<number, string>();
    const ordinals = new Set<number>();
    for (const m of group) {
      for (let o = m.ordinal - cfg.neighbourChunks; o <= m.ordinal + cfg.neighbourChunks; o++) {
        if (byOrdinal.has(o)) ordinals.add(o);
      }
    }
    const sorted = [...ordinals].sort((a, b) => a - b);
    // Consecutive parts overlap by the neighbour ring on both sides (ruling M4-G-R4), so each mention lies in a part
    // that also holds its neighbour chunks; it belongs to the first such part only.
    const overlap = Math.min(2 * cfg.neighbourChunks, cfg.maxChunksPerUnit - 1);
    const step = cfg.maxChunksPerUnit - overlap;
    const assigned = new Set<string>();
    let part = 0;
    for (let i = 0; i < sorted.length; i += step) {
      const from = i;
      const to = Math.min(i + cfg.maxChunksPerUnit, sorted.length) - 1;
      const own = group.filter((m) => {
        if (assigned.has(m.id)) return false;
        // Positions of its chunk and its neighbours that exist in the version (all of them are in `sorted`).
        const lo = sorted.findIndex((o) => o >= m.ordinal - cfg.neighbourChunks);
        const hi = sorted.findLastIndex((o) => o <= m.ordinal + cfg.neighbourChunks);
        // The last part takes whatever is left (a ring wider than a part can never fit whole).
        return (lo >= from && hi <= to) || to === sorted.length - 1;
      });
      for (const m of own) assigned.add(m.id);
      if (own.length > 0) {
        units.push({
          documentVersionId: versionId,
          geoObjectId,
          part: part++,
          level,
          mentionIds: own.map((m) => m.id),
          chunkIds: sorted.slice(from, to + 1).map((o) => byOrdinal.get(o)!),
        });
      }
      if (to === sorted.length - 1) break;
    }
  }
  return { units, skipped };
}
