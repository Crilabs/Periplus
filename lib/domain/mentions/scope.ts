import { sql } from "drizzle-orm";
import type { MentionsConfig, NameAffixesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { tileNeighbours } from "@/lib/domain/tiles";
import { nameFormsOf } from "./match";
import { linkTextOnly, nameForms, ngrams, type Ngram } from "./ngrams";

/*
 * Candidate space of the name match (spec 06): "Kacheln, die das Dokument bereits berührt … plus deren 8 Nachbarn;
 * bei unbekanntem Bezug das Revier der Quelle". The tiles a document touches come from a prepass over its text (names
 * of large objects: areas, gulfs, archipelagos, islands, and the area hints of its classification), else from the
 * mentions of its earlier versions; only without either, the SERP searches that found its source give its area;
 * `neighbourRing` 2 is a test switch.
 */

export type CandidateBasis = "prepass" | "history" | "source" | "fallback";

/** `values` as a subquery of text rows, sent as one JSON parameter (no parameter limit for long lists). */
export function jsonTexts(values: readonly string[]) {
  return sql`(select value from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}

/** `values` as a subquery of uuid rows. */
export function jsonUuids(values: readonly string[]) {
  return sql`(select value::uuid from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}

const validNow = (alias: string) =>
  sql.raw(`${alias}.valid_from <= current_date and (${alias}.valid_to is null or ${alias}.valid_to > current_date)`);

/** The exact forms the prepass looks for: n-gram forms of all chunks of the version and the classification's area hints. */
async function prepassForms(db: Db, versionId: string, cfg: MentionsConfig, affixes: NameAffixesConfig): Promise<string[]> {
  const { rows } = await db.execute<{ text: string; area_hints: string[] | null }>(sql`
    select c.text, v.area_hints
    from document_versions v left join chunks c on c.document_version_id = v.id
    where v.id = ${versionId}
    order by c.ordinal
  `);
  const grams: Ngram[] = [];
  for (const r of rows) if (r.text !== null) grams.push(...ngrams(linkTextOnly(r.text), cfg.maxNgramWords));
  const hints = rows[0]?.area_hints ?? [];
  for (const hint of hints) {
    const forms = nameForms(hint);
    if (forms.length > 0) grams.push({ start: 0, end: hint.length, surface: hint, forms, words: forms[0]!.split(" ").length });
  }
  return [...new Set(nameFormsOf(grams, { mentions: cfg, nameAffixes: affixes }).map((f) => f.form))];
}

/** (a) Tiles of the large objects (`prepassTypes`) the text names exactly, anywhere in the gazetteer. */
async function prepassTiles(db: Db, versionId: string, cfg: MentionsConfig, affixes: NameAffixesConfig): Promise<string[]> {
  const forms = await prepassForms(db, versionId, cfg, affixes);
  if (forms.length === 0) return [];
  const { rows } = await db.execute<{ tile_id: string }>(sql`
    with hit as (
      select distinct o.id, o.type
      from geo_names gn
      join geo_objects o on o.id = gn.geo_object_id
      where gn.name_normalized in ${jsonTexts(forms)}
        and ${validNow("gn")} and ${validNow("o")} and o.merged_into_id is null
        and o.type::text in ${jsonTexts(cfg.prepassTypes)}
    )
    select tgo.tile_id from hit join tile_geo_objects tgo on tgo.geo_object_id = hit.id
    union
    select t.id from hit join tiles t on t.area_id = hit.id where hit.type = 'area' and ${validNow("t")}
  `);
  return rows.map((r) => r.tile_id);
}

/** (b) Tiles of the objects mentioned in earlier versions (fetched before this one) of the same document. */
async function historyTiles(db: Db, versionId: string): Promise<string[]> {
  const { rows } = await db.execute<{ tile_id: string }>(sql`
    select distinct tgo.tile_id
    from document_versions v
    join document_versions w on w.document_id = v.document_id and w.fetched_at < v.fetched_at
    join mentions m on m.document_version_id = w.id
    join tile_geo_objects tgo on tgo.geo_object_id = m.geo_object_id
    where v.id = ${versionId}
  `);
  return rows.map((r) => r.tile_id);
}

/**
 * (c) Tiles of the SERP searches that found the version's source (`serp_results.domain` = `sources.domain`, both
 * registrable): the tile of a tile search, the tile of the place of a place search (ruling M5-P12), the tiles of the
 * area of an area search.
 */
async function sourceTiles(db: Db, versionId: string): Promise<string[]> {
  const { rows } = await db.execute<{ tile_id: string }>(sql`
    with q as (
      select distinct sq.level, sq.scope_id
      from document_versions v
      join documents d on d.id = v.document_id
      join sources s on s.id = d.source_id
      join serp_results r on r.domain = s.domain
      join serp_queries sq on sq.id = r.serp_query_id
      where v.id = ${versionId}
    )
    select t.id as tile_id from q join tiles t on t.id = q.scope_id where q.level = 'tile'
    union
    select p.tile_id from q
    join places p on p.geo_object_id::text = q.scope_id and p.tile_id is not null and p.merged_into_id is null and ${validNow("p")}
    where q.level = 'place'
    union
    select t.id from q
    join geo_objects a on a.type = 'area' and a.config_key = q.scope_id and ${validNow("a")}
    join tiles t on t.area_id = a.id and ${validNow("t")}
    where q.level = 'area'
  `);
  return rows.map((r) => r.tile_id);
}

/** Every tile of the configured areas, when nothing else gives the document a place. */
async function fallbackTiles(db: Db, areaKeys: readonly string[]): Promise<string[]> {
  if (areaKeys.length === 0) return [];
  const { rows } = await db.execute<{ tile_id: string }>(sql`
    select t.id as tile_id from tiles t
    join geo_objects a on a.id = t.area_id and a.type = 'area' and ${validNow("a")}
    where a.config_key in ${jsonTexts(areaKeys)} and ${validNow("t")}
  `);
  return rows.map((r) => r.tile_id);
}

/** The tiles plus `ring` rings of neighbours (1 = the 8 neighbours, 2 = the 24 tiles around). */
export function withNeighbours(tiles: Iterable<string>, ring: number): string[] {
  let current = new Set(tiles);
  for (let r = 0; r < ring; r++) {
    const next = new Set(current);
    for (const id of current) for (const n of tileNeighbours(id)) next.add(n);
    current = next;
  }
  return [...current].sort();
}

/**
 * The tiles whose objects a version's names are compared with (spec 06 over the plan, ruling M4-E-R4): the tiles the
 * document touches, (a) from the prepass; only when it touches none, (b) the tiles of its document's history; only when
 * both are empty, "bei unbekanntem Bezug", (c) its source's SERP area; each with `neighbourRing` rings of neighbours.
 * When all three are empty, every tile of the configured areas (`fallback`). `basis` names the step that gave tiles.
 */
export async function candidateTiles(
  db: Db,
  versionId: string,
  cfg: MentionsConfig,
  ctx: { nameAffixes: NameAffixesConfig; areaKeys: readonly string[] },
): Promise<{ tiles: string[]; basis: CandidateBasis }> {
  const steps: Array<[CandidateBasis, () => Promise<string[]>]> = [
    ["prepass", () => prepassTiles(db, versionId, cfg, ctx.nameAffixes)],
    ["history", () => historyTiles(db, versionId)],
    ["source", () => sourceTiles(db, versionId)],
  ];
  for (const [basis, tilesOf] of steps) {
    const tiles = await tilesOf();
    if (tiles.length > 0) return { tiles: withNeighbours(tiles, cfg.neighbourRing), basis };
  }
  return { tiles: [...new Set(await fallbackTiles(db, ctx.areaKeys))].sort(), basis: "fallback" };
}

/**
 * The valid objects of the tiles (`tile_geo_objects`), the label areas of the tiles, and all their valid ancestors
 * (an island named in a text about one of its bays), in id order.
 */
export async function candidateObjects(db: Db, tiles: string[]): Promise<string[]> {
  if (tiles.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    with recursive base as (
      select tgo.geo_object_id as id from tile_geo_objects tgo where tgo.tile_id in ${jsonTexts(tiles)}
      union
      select t.area_id from tiles t where t.id in ${jsonTexts(tiles)} and t.area_id is not null
    ),
    up as (
      select o.id, o.parent_id from geo_objects o join base on base.id = o.id
      where ${validNow("o")} and o.merged_into_id is null
      union
      select p.id, p.parent_id from geo_objects p join up on p.id = up.parent_id
      where ${validNow("p")} and p.merged_into_id is null
    )
    select distinct id from up order by id
  `);
  return rows.map((r) => r.id);
}
