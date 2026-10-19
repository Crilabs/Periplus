import { sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { candidateObjects, candidateTiles, jsonUuids } from "./scope";

/*
 * Measurement for the open point "Kachelgrenzen (M4)" of the overall design: would a second ring of neighbour tiles in
 * the candidate space (`config/mentions.json` `neighbourRing` 2) find names the match leaves unmatched today? A dry run:
 * nothing is written, `neighbourRing` stays as configured until the decision is documented in
 * `docs/pilot/m4-abnahme.md`.
 */

export type TileBorderMeasurement = { unmatchedNames: number; matchedWithRing2: number };

/**
 * The unmatched names recorded since `since` (default: the last 30 days; `versionIds` narrows them to those versions)
 * and how many of them the candidate space with two neighbour rings would match exactly: a valid geo object of the
 * second ring, outside the one-ring candidate space, has a name with the same normalized form.
 */
export async function measureTileBorders(
  db: Db,
  cfg: AppConfig = getConfig(),
  opts: { since?: Date; versionIds?: string[] } = {},
): Promise<TileBorderMeasurement> {
  const since = opts.since ?? new Date(Date.now() - 30 * 86_400_000);
  const versionFilter = opts.versionIds ? sql`and u.document_version_id in ${jsonUuids(opts.versionIds)}` : sql``;
  const { rows } = await db.execute<{ version_id: string; name_normalized: string }>(sql`
    select u.document_version_id as version_id, u.name_normalized
    from unmatched_names u
    where u.created_at >= ${since.toISOString()}::timestamptz ${versionFilter}
    order by u.document_version_id, u.name_normalized, u.id
  `);
  const ctx = { nameAffixes: cfg.nameAffixes, areaKeys: cfg.areas.map((a) => a.key) };
  const byVersion = new Map<string, string[]>();
  for (const r of rows) byVersion.set(r.version_id, [...(byVersion.get(r.version_id) ?? []), r.name_normalized]);
  let matched = 0;
  for (const [versionId, names] of byVersion) {
    const ring1 = new Set(await candidateObjects(db, (await candidateTiles(db, versionId, { ...cfg.mentions, neighbourRing: 1 }, ctx)).tiles));
    const ring2 = (await candidateObjects(db, (await candidateTiles(db, versionId, { ...cfg.mentions, neighbourRing: 2 }, ctx)).tiles)).filter((id) => !ring1.has(id));
    if (ring2.length === 0) continue;
    const { rows: hits } = await db.execute<{ name_normalized: string }>(sql`
      select distinct n.name_normalized from geo_names n
      where n.geo_object_id in ${jsonUuids(ring2)}
        and n.name_normalized in (select value from jsonb_array_elements_text(${JSON.stringify([...new Set(names)])}::jsonb))
        and (n.valid_to is null or n.valid_to > current_date)
    `);
    const found = new Set(hits.map((h) => h.name_normalized));
    matched += names.filter((n) => found.has(n)).length;
  }
  return { unmatchedNames: rows.length, matchedWithRing2: matched };
}
