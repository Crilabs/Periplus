import { and, eq, getTableName, inArray, is, isNull, SQL, sql, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/lib/db/client";
import { geoNames, type NameOrigin, type NameScript } from "@/lib/db/schema";
import { validAt } from "@/lib/domain/timeline";

/**
 * A name as delivered by an import; `language` is ISO 639-1 or `"und"`.
 * `isPreferred: true` only applies when the language has no valid preferred row yet for the object;
 * otherwise it is ignored. The one takeover: a real (non-fallback) name of a language ends the valid
 * `fallback` row of that language and then becomes preferred (see `addNames`).
 */
export type NameDraft = { name: string; language: string; origin: NameOrigin; isPreferred?: boolean };

const GREEK_LETTER = /(?=\p{L})\p{Script=Greek}/gu;
const LATIN_LETTER = /(?=\p{L})\p{Script=Latin}/gu;

/** True when the string has more Greek than Latin letters. */
export function isGreek(s: string): boolean {
  const greek = s.match(GREEK_LETTER)?.length ?? 0;
  const latin = s.match(LATIN_LETTER)?.length ?? 0;
  return greek > latin;
}

/**
 * Search key: decomposed, without diacritics (incl. tonos and diaeresis), lower case, `ς → σ`,
 * punctuation as space, whitespace collapsed and trimmed.
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const SINGLE: Record<string, string> = {
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m",
  ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o",
};
const DIGRAPHS: Record<string, string> = {
  αι: "ai", ει: "ei", οι: "oi", ου: "ou", υι: "yi", γγ: "ng", γξ: "nx", γχ: "nch", γκ: "gk",
  μπ: "mp", ντ: "nt", τσ: "ts", τζ: "tz",
};
/** αυ/ευ/ηυ: the υ is voiced (v) before these, voiceless (f) otherwise, also at the end of a word. */
const UPSILON_DIGRAPH: Record<string, [string, string]> = { α: ["av", "af"], ε: ["ev", "ef"], η: ["iv", "if"] };
const VOICED_AFTER_UPSILON = new Set("αεηιουωβγδζλμνρ");
const DIAERESIS = "\u0308";

type Letter = { char: string; upper: boolean; diaeresis: boolean };

/** Splits into runs of Greek letters (with their diacritics folded in) and everything else. */
function greekRuns(s: string): (Letter[] | string)[] {
  const out: (Letter[] | string)[] = [];
  for (const ch of s.normalize("NFD")) {
    const last = out.at(-1);
    if (/\p{M}/u.test(ch)) {
      if (Array.isArray(last)) {
        if (ch === DIAERESIS) last.at(-1)!.diaeresis = true;
      } else if (last === undefined) {
        out.push(ch);
      } else {
        out[out.length - 1] = last + ch;
      }
    } else if (/(?=\p{L})\p{Script=Greek}/u.test(ch)) {
      const lower = ch.toLowerCase();
      const letter = { char: lower, upper: lower !== ch, diaeresis: false };
      if (Array.isArray(last)) last.push(letter);
      else out.push([letter]);
    } else if (typeof last === "string") {
      out[out.length - 1] = last + ch;
    } else {
      out.push(ch);
    }
  }
  return out;
}

function transliterateWord(letters: Letter[]): string {
  let out = "";
  for (let i = 0; i < letters.length; ) {
    const c = letters[i]!.char;
    const next = letters[i + 1];
    const upsilon = UPSILON_DIGRAPH[c];
    if (upsilon && next?.char === "υ" && !next.diaeresis) {
      const after = letters[i + 2];
      out += after && VOICED_AFTER_UPSILON.has(after.char) ? upsilon[0] : upsilon[1];
      i += 2;
      continue;
    }
    const digraph = next && !next.diaeresis ? DIGRAPHS[c + next.char] : undefined;
    if (digraph) {
      out += digraph;
      i += 2;
      continue;
    }
    out += SINGLE[c] ?? c;
    i += 1;
  }
  if (letters.length > 1 && letters.every((l) => l.upper)) return out.toUpperCase();
  return letters[0]?.upper ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

/**
 * ELOT 743 (type 1) transliteration of Greek letters; capitalisation is taken over per word
 * (capitalised or all caps), tonos and diaeresis are dropped, everything non-Greek passes through.
 */
export function transliterateElot743(s: string): string {
  return greekRuns(s)
    .map((run) => (typeof run === "string" ? run : transliterateWord(run)))
    .join("")
    .normalize("NFC");
}

type NameRow = {
  name: string;
  nameNormalized: string;
  language: string;
  script: NameScript;
  origin: NameOrigin;
  isPreferred: boolean;
};

/**
 * The preferred name of a language: an explicit `isPreferred`, else the first `osm` name, else the first
 * name. Transliterations are never preferred; languages that already have a valid preferred name keep it.
 */
function markPreferred(rows: NameRow[], explicit: Set<NameRow>, languagesWithPreferred: Set<string>): void {
  const byLanguage = new Map<string, NameRow[]>();
  for (const row of rows) {
    if (row.origin === "transliteration" || languagesWithPreferred.has(row.language)) continue;
    byLanguage.set(row.language, [...(byLanguage.get(row.language) ?? []), row]);
  }
  for (const candidates of byLanguage.values()) {
    const chosen =
      candidates.find((r) => explicit.has(r)) ?? candidates.find((r) => r.origin === "osm") ?? candidates[0]!;
    chosen.isPreferred = true;
  }
}

/**
 * Writes one valid geo_names row per name, plus the ELOT 743 transliteration of every Greek name
 * (`language "el"`, `script latin`, `origin transliteration`). Idempotent via the valid-name unique index.
 * Returns the number of new rows.
 */
export async function addNames(db: Db, geoObjectId: string, names: NameDraft[]): Promise<number> {
  const rows: NameRow[] = [];
  const explicit = new Set<NameRow>();
  const seen = new Set<string>();
  const push = (row: NameRow, isExplicit = false) => {
    const key = JSON.stringify([row.name, row.language, row.origin]);
    if (seen.has(key) || row.nameNormalized === "") return;
    seen.add(key);
    rows.push(row);
    if (isExplicit) explicit.add(row);
  };
  for (const draft of names) {
    const name = draft.name.trim().replace(/\s+/g, " ");
    const greek = isGreek(name);
    push({
      name,
      nameNormalized: normalizeName(name),
      language: draft.language,
      script: greek ? "greek" : "latin",
      origin: draft.origin,
      isPreferred: false,
    }, draft.isPreferred === true);
    if (greek) {
      const latin = transliterateElot743(name);
      push({
        name: latin,
        nameNormalized: normalizeName(latin),
        language: "el",
        script: "latin",
        origin: "transliteration",
        isPreferred: false,
      });
    }
  }
  if (rows.length === 0) return 0;

  // A real name replaces the fallback of its language: end the fallback row (never delete it).
  const realLanguages = [
    ...new Set(rows.filter((r) => r.origin !== "fallback" && r.origin !== "transliteration").map((r) => r.language)),
  ];
  if (realLanguages.length > 0) {
    await db
      .update(geoNames)
      .set({ validTo: sql`current_date` })
      .where(
        and(
          eq(geoNames.geoObjectId, geoObjectId),
          eq(geoNames.origin, "fallback"),
          isNull(geoNames.validTo),
          inArray(geoNames.language, realLanguages),
        ),
      );
  }

  const existingPreferred = await db
    .selectDistinct({ language: geoNames.language })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, geoObjectId), eq(geoNames.isPreferred, true), isNull(geoNames.validTo)));
  markPreferred(rows, explicit, new Set(existingPreferred.map((r) => r.language)));

  const inserted = await db
    .insert(geoNames)
    .values(rows.map((row) => ({ ...row, geoObjectId })))
    .onConflictDoNothing()
    .returning({ id: geoNames.id });
  return inserted.length;
}

/**
 * For valid objects without a valid `de` name but with a valid `en` name: writes `de` = the preferred
 * (else oldest) `en` name with `origin fallback`. Restricted to `geoObjectIds` when given.
 * Returns the number of new rows.
 */
export async function ensureFallbackNames(db: Db, geoObjectIds?: string[]): Promise<number> {
  if (geoObjectIds?.length === 0) return 0;
  const scope = geoObjectIds ? sql`and en.geo_object_id in ${geoObjectIds}` : sql``;
  const { rows: sources } = await db.execute<{
    geo_object_id: string;
    name: string;
    name_normalized: string;
    script: NameScript;
  }>(sql`
    select distinct on (en.geo_object_id) en.geo_object_id, en.name, en.name_normalized, en.script
    from geo_names en
    join geo_objects o on o.id = en.geo_object_id and o.valid_to is null
    where en.language = 'en' and en.valid_to is null ${scope}
      and not exists (
        select 1 from geo_names de
        where de.geo_object_id = en.geo_object_id and de.language = 'de' and de.valid_to is null
      )
    order by en.geo_object_id, en.is_preferred desc, en.created_at, en.id
  `);
  if (sources.length === 0) return 0;
  const inserted = await db
    .insert(geoNames)
    .values(
      sources.map((s) => ({
        geoObjectId: s.geo_object_id,
        name: s.name,
        nameNormalized: s.name_normalized,
        language: "de",
        script: s.script,
        origin: "fallback" as const,
        isPreferred: true,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: geoNames.id });
  return inserted.length;
}

/** geo_names inside the display-name subquery, aliased so no outer column can be mistaken for its own. */
const gn = alias(geoNames, "gn");

/** A column rendered as `"table"."column"` in any query, unlike a bare column in a single-table select. */
function qualified(column: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

/**
 * Display name of a geo object as a scalar subquery: a valid German name, else English, else any valid name;
 * within a language the preferred name first, then alphabetical. Null when the object has no valid name.
 *
 * `geoObjectId` is the outer query's id: a column (rendered table-qualified, so it can never resolve to
 * a column of the inner `geo_names gn`) or an SQL expression such as an alias column (`sql\`o.id\``).
 */
export function displayNameSql(geoObjectId: SQL | AnyColumn): SQL<string | null> {
  const outerId = is(geoObjectId, SQL) ? geoObjectId : qualified(geoObjectId);
  return sql<string | null>`(
    select gn.name from geo_names gn
    where gn.geo_object_id = ${outerId} and ${validAt(gn)}
    order by case gn.language when 'de' then 0 when 'en' then 1 else 2 end, gn.is_preferred desc, gn.name
    limit 1
  )`;
}
