import { eq, sql } from "drizzle-orm";
import type { BundleFactInput, BundleFactsOutput } from "@/lib/ai/tasks/bundle-facts";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { berthStates, type BerthStateFact } from "@/lib/db/schema";
import type { Tone } from "@/lib/db/schema/research-extract";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { activeAssessor } from "./assessment";
import { activeExtractor } from "./confirmation";
import { liveResearchSourceSql } from "./sources";

/*
 * Free facts of a berth state (plan N4a task 3): the statements of done units of the active `extract-berth` model and
 * prompt, bundled by the model into groups of equivalent facts (`bundle-facts`). The bundling writes no text: the
 * representative of a group is an existing `berth_facts` row, and the ids a newer fact of the group contradicts are
 * left out. The free facts are read as the core values are (`coreInputs`): the document's current version, a page with
 * an active, not generated assessment, a live source.
 */

/** A free fact with what the stored fact needs besides the model's input. */
export type FreeFact = BundleFactInput & { subjectCategory: string | null; safety: boolean; domain: string };

type FactRow = {
  id: string;
  statement: string;
  subject_name: string | null;
  subject_category: string | null;
  observed_at: string;
  tone: Tone | null;
  safety: boolean;
  url: string;
};

/** The free facts of the place, oldest observation first (ties by id). */
export async function freeFacts(db: Db, placeId: string, config: AppConfig): Promise<FreeFact[]> {
  const extractor = activeExtractor(config);
  const assessor = activeAssessor(config);
  const { rows } = await db.execute<FactRow>(sql`
    select f.id, f.statement, f.subject_name, f.subject_category, f.observed_at::text as observed_at, f.tone::text as tone, f.safety, d.url
    from berth_facts f
    join research_units u on u.id = f.unit_id
    join documents d on d.current_version_id = f.document_version_id
    join sources src on src.id = d.source_id
    join page_assessments a on a.document_version_id = f.document_version_id and a.model = ${assessor.model} and a.prompt_version = ${assessor.promptVersion}
    where f.place_id = ${placeId} and f.statement is not null
      and u.status = 'done' and u.model = ${extractor.model} and u.prompt_version = ${extractor.promptVersion}
      and a.generated = false and ${liveResearchSourceSql("src")}
    order by f.observed_at, f.id`);
  return rows.map((r) => {
    // `extractBerth` keeps a subject name and category only for a fact about a thing on land.
    const landside = r.subject_name !== null || r.subject_category !== null;
    return {
      id: r.id,
      subject: landside ? "landside" : "berth",
      subjectName: r.subject_name,
      subjectCategory: r.subject_category,
      statement: r.statement,
      observedAt: r.observed_at,
      tone: r.tone,
      safety: r.safety,
      domain: registrableDomain(r.url),
    };
  });
}

/** The part of a free fact the model sees. */
export function bundleInput(f: FreeFact): BundleFactInput {
  return { id: f.id, subject: f.subject, subjectName: f.subjectName, statement: f.statement, observedAt: f.observedAt, tone: f.tone };
}

type Group = BundleFactsOutput["groups"][number];

/**
 * The groups of the answer that hold, checked against the facts the model was given. A group is dropped, its facts
 * becoming single ones, when it names an id that was not offered or that an earlier group already holds, repeats an id,
 * has a representative outside its ids, names a superseded id outside its ids or the representative itself, or
 * supersedes a fact that no fact of the group is strictly newer than. Pure.
 */
export function validGroups(offered: Array<{ id: string; observedAt: string }>, groups: Group[]): Group[] {
  const dates = new Map(offered.map((f) => [f.id, f.observedAt]));
  const taken = new Set<string>();
  const valid: Group[] = [];
  for (const g of groups) {
    const ids = new Set(g.ids);
    const ok =
      g.ids.length > 0 &&
      ids.size === g.ids.length &&
      g.ids.every((id) => dates.has(id) && !taken.has(id)) &&
      ids.has(g.representative) &&
      new Set(g.superseded).size === g.superseded.length &&
      g.superseded.every((id) => id !== g.representative && ids.has(id) && g.ids.some((other) => dates.get(other)! > dates.get(id)!));
    if (!ok) continue;
    for (const id of g.ids) taken.add(id);
    valid.push(g);
  }
  return valid;
}

function stored(f: FreeFact, mentions: number): BerthStateFact {
  return {
    factId: f.id,
    subject: f.subject,
    subjectName: f.subjectName,
    subjectCategory: f.subjectCategory,
    statement: f.statement,
    observedAt: f.observedAt,
    tone: f.tone,
    safety: f.safety,
    mentions,
  };
}

/**
 * The bundled facts of a berth: per valid group (`validGroups`) its representative with `mentions` the number of
 * distinct registrable domains of the group's facts, without the superseded ones (they are contradicted, so their
 * sources do not stand behind the representative); every free fact outside a valid group stands alone with one
 * mention. `groups` null (no or a broken answer) bundles nothing. A fact that is no longer free (`free` is the
 * current set) leaves its group; a group whose representative is gone dissolves into single facts. Ordered as `free`.
 * Pure.
 */
export function bundleFacts(free: FreeFact[], offered: Array<{ id: string; observedAt: string }>, groups: Group[] | null): BerthStateFact[] {
  const byId = new Map(free.map((f) => [f.id, f]));
  const covered = new Set<string>();
  const out = new Map<string, BerthStateFact>();
  for (const g of groups ? validGroups(offered, groups) : []) {
    const rep = byId.get(g.representative);
    if (!rep) continue;
    const superseded = new Set(g.superseded);
    const members = g.ids.filter((id) => byId.has(id));
    for (const id of members) covered.add(id);
    const domains = new Set(members.filter((id) => !superseded.has(id)).map((id) => byId.get(id)!.domain));
    out.set(rep.id, stored(rep, domains.size));
  }
  return free.flatMap((f) => (out.has(f.id) ? [out.get(f.id)!] : covered.has(f.id) ? [] : [stored(f, 1)]));
}

/**
 * Writes the bundled facts of the place into `berth_states.facts`: the row is created with empty core values, gaps,
 * landing and nearby when it does not exist yet (the state stage fills them), and only `facts` is changed on an
 * existing one (no row is created for no facts). The state stage's own upsert must leave `facts` alone.
 */
export async function storeStateFacts(db: Db, placeId: string, facts: BerthStateFact[]): Promise<void> {
  if (facts.length === 0) {
    // nothing to show: clear a row that exists, create none
    await db.update(berthStates).set({ facts }).where(eq(berthStates.placeId, placeId));
    return;
  }
  await db
    .insert(berthStates)
    .values({ placeId, core: {}, gaps: [], facts, landing: [], nearby: [] })
    .onConflictDoUpdate({ target: berthStates.placeId, set: { facts } });
}
