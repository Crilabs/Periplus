import { sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { jsonTexts, jsonUuids, prepassCandidateTiles, withNeighbours } from "@/lib/domain/mentions/scope";
import { MATCH_PASS_STAGE } from "@/lib/domain/mentions/store";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";

/*
 * Stage `mentions.reread` of a subdivision build (spec 14 „Nachlesen beim Start eines Landesteils“): after the
 * subdivision's fine gazetteer, documents fetched earlier (a „Saronic Gulf“ report found for Attika) may name places
 * of the new subdivision. The stage (`startRereadForSubdivision` in `./run`) starts a separate reprocess run (stage 6 on) over the current versions whose
 * prepass touches the subdivision's scope tiles, and ends; the build does not wait for it.
 */

export const REREAD_STAGE = "mentions.reread";

/**
 * Letters `normalizeName` reduces to one other letter (NFD, combining marks removed), found by trying every code point of
 * Latin-1 Supplement, Latin Extended-A/B and Latin Extended Additional, and their base letters (same positions), for
 * `translate`: ğ, ş, ġ, ċ, ţ and the rest, not a hand-picked list.
 */
const [ACCENTED, BASE] = (() => {
  const from: string[] = [];
  const to: string[] = [];
  const ranges: Array<[number, number]> = [[0xc0, 0x24f], [0x1e00, 0x1eff]];
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp++) {
      const c = String.fromCodePoint(cp);
      const base = c.normalize("NFD").replace(/\p{M}/gu, "");
      if (base !== c && [...base].length === 1) {
        from.push(c);
        to.push(base);
      }
    }
  }
  return [from.join(""), to.join("")];
})();
const GREEK_SCRIPT = "[\\u0370-\\u03ff\\u1f00-\\u1fff]";

/** LIKE pattern of a normalized name: its words in order with anything between (commas, dashes). */
const likePattern = (name: string) => `%${name.split(" ").map((w) => w.replace(/[\\%_]/g, "\\$&")).join("%")}%`;

/**
 * Names whose appearance in a text can make its prepass touch a scope tile of subdivision `sub`: the names of the
 * `prepassTypes` objects (except country, sea, admin_region, which expand differently) linked to those tiles plus the
 * `neighbourRing` rings around them, and the names of the admin region of every valid subdivision whose scope tiles
 * reach them (`prepassTiles` expands a named region into the scope tiles of its subdivision).
 */
export async function prefilterNames(db: Db, scope: string[], cfg: AppConfig): Promise<string[]> {
  const reach = withNeighbours(scope, cfg.mentions.neighbourRing);
  const plain = cfg.mentions.prepassTypes.filter((t) => !["country", "sea", "admin_region"].includes(t));
  const reachSet = new Set(reach);
  const regionIds: string[] = [];
  if (cfg.mentions.prepassTypes.includes("admin_region")) {
    const { rows: subs } = await db.execute<{ id: string; geo_object_id: string }>(sql`
      select s.id, s.geo_object_id from subdivisions s where s.valid_to is null and s.geo_object_id is not null
    `);
    for (const s of subs) if ((await subdivisionTileIds(db, s.id)).some((t) => reachSet.has(t))) regionIds.push(s.geo_object_id);
  }
  const { rows } = await db.execute<{ name_normalized: string }>(sql`
    select distinct gn.name_normalized
    from geo_names gn join geo_objects o on o.id = gn.geo_object_id
    where gn.valid_from <= current_date and (gn.valid_to is null or gn.valid_to > current_date)
      and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date) and o.merged_into_id is null
      and (
        (o.type::text in ${jsonTexts(plain)} and exists (select 1 from tile_geo_objects tgo where tgo.geo_object_id = o.id and tgo.tile_id in ${jsonTexts(reach)}))
        or o.id in ${jsonUuids(regionIds)}
      )
  `);
  return rows.map((r) => r.name_normalized).filter((n) => n.length > 0);
}

/**
 * Current versions of active documents that passed the name match once (a never matched version is pending and left to
 * the pending runs, as `textRunVersions` does for rematch runs) and whose text can name one of `names`: a chunk or an
 * area hint contains the name (LIKE, case-insensitive, accented letters folded to their base letter), or a chunk is in greek script (names match through the
 * transliteration there). Sound, not exact: the prepass confirms.
 */
export async function prefilteredVersions(db: Db, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const patterns = JSON.stringify(names.map(likePattern));
  const P = sql`array(select value from jsonb_array_elements_text(${patterns}::jsonb))`;
  const foldSql = (expr: ReturnType<typeof sql.raw>) =>
    sql`regexp_replace(translate(${expr}, ${ACCENTED}, ${BASE}), '[^[:alnum:]\x01-\x7f]+', ' ', 'g')`;
  const text = sql.raw("c.text_normalized");
  const hints = sql.raw("array_to_string(v.area_hints, ' ')");
  const { rows } = await db.execute<{ id: string }>(sql`
    select v.id
    from documents d join document_versions v on v.id = d.current_version_id
    where d.status = 'active' and d.valid_to is null
      and exists (select 1 from pipeline_passes p where p.document_version_id = v.id and p.stage = ${MATCH_PASS_STAGE})
      and (
        exists (
          select 1 from chunks c where c.document_version_id = v.id
            and (${text} ilike any (${P}) or ${foldSql(text)} ilike any (${P}) or ${text} ~ ${GREEK_SCRIPT})
        )
        or ${hints} ilike any (${P}) or ${foldSql(hints)} ilike any (${P}) or ${hints} ~ ${GREEK_SCRIPT}
      )
    order by v.id
  `);
  return rows.map((r) => r.id);
}

/**
 * The current versions of active documents, already matched once, whose prepass (the large objects their text names,
 * `prepassTypes`, with `neighbourRing` rings of neighbours, exactly as `candidateTiles` takes it) touches a scope tile of
 * subdivision `key`, in id order. A name prefilter (`prefilterNames`) keeps the prepass from running over the whole archive.
 */
export async function rereadVersions(db: Db, key: string, cfg: AppConfig = getConfig()): Promise<string[]> {
  const sub = await requireSubdivision(db, key);
  const scope = await subdivisionTileIds(db, sub.id);
  if (scope.length === 0) return [];
  const scopeSet = new Set(scope);
  const ids: string[] = [];
  for (const id of await prefilteredVersions(db, await prefilterNames(db, scope, cfg))) {
    if ((await prepassCandidateTiles(db, id, cfg.mentions, cfg.nameAffixes)).some((t) => scopeSet.has(t))) ids.push(id);
  }
  return ids;
}
