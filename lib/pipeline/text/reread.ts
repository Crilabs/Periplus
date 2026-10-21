import { sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { prepassTiles } from "@/lib/domain/mentions/scope";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";

/*
 * Stage `mentions.reread` of a subdivision build (spec 14 „Nachlesen beim Start eines Landesteils“): after the
 * subdivision's fine gazetteer, documents fetched earlier (a „Saronic Gulf“ report found for Attika) may name places
 * of the new subdivision. The stage (`startRereadForSubdivision` in `./run`) starts a separate reprocess run (stage 6 on) over the current versions whose
 * prepass touches the subdivision's scope tiles, and ends; the build does not wait for it.
 */

export const REREAD_STAGE = "mentions.reread";

/**
 * The current versions of active documents whose prepass (the large objects their text names, `prepassTypes`) touches
 * a scope tile of subdivision `key`, in id order.
 */
export async function rereadVersions(db: Db, key: string, cfg: AppConfig = getConfig()): Promise<string[]> {
  const sub = await requireSubdivision(db, key);
  const scope = new Set(await subdivisionTileIds(db, sub.id));
  if (scope.size === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    select v.id
    from documents d join document_versions v on v.id = d.current_version_id
    where d.status = 'active' and d.valid_to is null
    order by v.id
  `);
  const ids: string[] = [];
  for (const { id } of rows) {
    if ((await prepassTiles(db, id, cfg.mentions, cfg.nameAffixes)).some((t) => scope.has(t))) ids.push(id);
  }
  return ids;
}
