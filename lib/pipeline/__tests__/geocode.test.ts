import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { externalCalls, nameCandidates, reviewTasks, sources, unmatchedNames } from "@/lib/db/schema";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { tileIdFor } from "@/lib/domain/tiles";
import {
  collectNameCandidates,
  geocodeCandidate,
  occurrenceSnippet,
  planGeocode,
  type NameCandidateContext,
} from "@/lib/pipeline/text/geocode";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSource, insertTestTile, insertTestVersion } from "@/test/text";

/*
 * Always in withRollback, with names of their own (`<uuid>` letters) on the synthetic grid around 21.0° E / 35.2° N;
 * assertions only on the test's own rows (ruling M4-P23).
 */

const config: AppConfig = loadConfig("config");
const TILE = tileIdFor(21.05, 35.2);

/**
 * A capitalised name no other test uses: the random tail of a fresh UUID, digits spelled as letters (the head of a
 * UUIDv7 is its timestamp, equal for two ids of the same millisecond).
 */
const ownName = () =>
  `Xen${newId()
    .replace(/-/g, "")
    .slice(-16)
    .replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!)}`;

/** A clock one second further at every reading: the one-per-second bucket never makes a test wait. */
function steppingClock(): { now: () => Date } {
  let t = Date.UTC(2031, 0, 1);
  return { now: () => new Date((t += 1000)) };
}

type Hit = { osm_type: string; osm_id: number; lat: string; lon: string; category: string; type: string; name: string; display_name: string };
const hit = (id: number, lon: number, lat: number, name: string): Hit => ({
  osm_type: "node",
  osm_id: id,
  lat: String(lat),
  lon: String(lon),
  category: "natural",
  type: "bay",
  name,
  display_name: `${name}, Testinsel`,
});

/** A Nominatim stand-in answering `hits` and remembering every request. */
function nominatim(hits: Hit[]): { transport: Transport; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return {
    seen,
    transport: async (req) => {
      seen.push(req);
      return makeResponse(200, new TextEncoder().encode(JSON.stringify(hits)));
    },
  };
}

/** One version per entry (`sourceId` reused where given) whose chunk names `name`; one unmatched row each. */
async function namedIn(tx: Db, name: string, sources: string[]): Promise<string[]> {
  const versionIds: string[] = [];
  for (const sourceId of sources) {
    const text = `Wir ankerten in der Bucht von ${name}, gut geschützt vor dem Meltemi, Sand auf fünf Metern.`;
    const v = await insertTestVersion(tx, [text], { sourceId });
    await tx.insert(unmatchedNames).values({
      nameNormalized: normalizeName(name),
      displayName: name,
      hint: "bay",
      documentVersionId: v.versionId,
      chunkId: v.chunkIds[0]!,
      sourceId,
      tileId: TILE,
    });
    versionIds.push(v.versionId);
  }
  return versionIds;
}

async function textRun(tx: Db, documentVersionIds: string[]): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "stage",
    scope: { type: "system", id: "texts" },
    stages: [],
    params: { documentVersionIds },
    triggeredBy: "test",
  });
  return id;
}

async function candidateOf(tx: Db, name: string) {
  const [row] = await tx
    .select()
    .from(nameCandidates)
    .where(and(eq(nameCandidates.nameNormalized, normalizeName(name)), eq(nameCandidates.tileId, TILE)));
  return row;
}

describe("collectNameCandidates", () => {
  it("a name in 2 documents of one source is not a candidate", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const name = ownName();
      const source = await insertTestSource(tx);
      const versions = await namedIn(tx, name, [source, source]);
      const runId = await textRun(tx, versions);

      expect(await collectNameCandidates(tx, runId, config)).toEqual([]);
      expect(await candidateOf(tx, name)).toBeUndefined();
    }));

  it("an ended and re-created source of one domain counts as one source", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const name = ownName();
      const ended = await insertTestSource(tx);
      const [{ domain }] = (await tx.select({ domain: sources.domain }).from(sources).where(eq(sources.id, ended))) as [{ domain: string }];
      await tx.update(sources).set({ validTo: "2026-10-01" }).where(eq(sources.id, ended));
      const [recreated] = await tx
        .insert(sources)
        .values({ domain, name: "Test source again", type: "trip_report", weight: 0.6, crawlRules: { startUrls: [] }, origin: "manual" })
        .returning({ id: sources.id });
      const versions = await namedIn(tx, name, [ended, recreated!.id]);

      expect(await collectNameCandidates(tx, await textRun(tx, versions), config)).toEqual([]);
      expect(await candidateOf(tx, name)).toBeUndefined();
    }));

  it("counts over all hints of a group, but only groups the run's versions name", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const name = ownName();
      const other = ownName();
      const [a, b] = [await insertTestSource(tx), await insertTestSource(tx)];
      const [first, second] = await namedIn(tx, name, [a, b]);
      const otherVersions = await namedIn(tx, other, [a, b]);

      // The run holds only the second version of `name`: the first one (an earlier run's) still counts.
      const ids = await collectNameCandidates(tx, await textRun(tx, [second!]), config);
      const c = await candidateOf(tx, name);
      expect(ids).toEqual([c!.id]);
      expect(c).toMatchObject({ displayName: name, hint: "bay", documents: 2, sources: 2, status: "collecting" });
      expect(await candidateOf(tx, other)).toBeUndefined();
      expect(first).toBeDefined();
      expect(otherVersions).toHaveLength(2);
    }));

  it("a name the gazetteer knows elsewhere (here with an affix) is no candidate", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const name = ownName();
      await insertNamedObject(tx, { type: "bay", names: [{ name: `Ormos ${name}` }], lon: 22.9, lat: 36.4 });
      const versions = await namedIn(tx, name, [await insertTestSource(tx), await insertTestSource(tx)]);

      expect(await collectNameCandidates(tx, await textRun(tx, versions), config)).toEqual([]);
      expect(await candidateOf(tx, name)).toBeUndefined();
    }));
});

describe("geocodeCandidate", () => {
  it("a name in 2 documents of 2 sources becomes one review task with its occurrences", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const name = ownName();
      const [a, b] = [await insertTestSource(tx), await insertTestSource(tx)];
      const versions = await namedIn(tx, name, [a, b]);
      const runId = await textRun(tx, versions);
      const jobs = await planGeocode(tx, { id: runId }, config);
      const candidate = await candidateOf(tx, name);
      expect(jobs).toEqual([{ key: `geocode:${candidate!.id}`, candidateId: candidate!.id }]);

      const far = hit(2, 21.2, 35.3, `${name} Bay`);
      const near = hit(1, 21.13, 35.13, name);
      const { transport, seen } = nominatim([far, near, hit(3, 21.0, 35.0, "c"), hit(4, 21.1, 35.4, "d"), hit(5, 21.3, 35.1, "e"), hit(6, 21.2, 35.0, "f")]);
      const result = await geocodeCandidate(tx, candidate!.id, { transport, http: steppingClock() }, { runId, cfg: config });

      expect(seen).toHaveLength(1);
      expect(new URL(seen[0]!.url).searchParams.get("q")).toBe(name);
      const tasks = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, candidate!.id));
      expect(tasks).toHaveLength(1);
      const task = tasks[0]!;
      expect(result).toEqual({ hits: 6, taskId: task.id });
      expect(task).toMatchObject({ kind: "place_candidate", subjectType: "name_candidate", status: "open", priority: 2 });
      const context = task.context as NameCandidateContext;
      expect(context).toMatchObject({ name, hint: "bay", tileId: TILE });
      expect(context.hits).toHaveLength(5);
      expect(context.hits[0]).toMatchObject({ osmId: "node/1", name });
      expect(context.occurrences.map((o) => o.versionId).sort()).toEqual([...versions].sort());
      for (const o of context.occurrences) expect(o.snippet.slice(o.start, o.end)).toBe(name);

      const after = await candidateOf(tx, name);
      expect(after!.status).toBe("review");
      expect(after!.geocode).toHaveLength(6);
      const calls = await tx.select().from(externalCalls).where(and(eq(externalCalls.service, "nominatim"), eq(externalCalls.runId, runId)));
      expect(calls).toMatchObject([{ stage: "mentions.geocode", tileId: TILE }]);

      // A retried job finds the task and asks Nominatim nothing more; the next plan offers the candidate no more.
      expect(await geocodeCandidate(tx, candidate!.id, { transport, http: steppingClock() }, { runId, cfg: config })).toEqual(result);
      expect(seen).toHaveLength(1);
      expect(await planGeocode(tx, { id: runId }, config)).toEqual([]);
    }));

  it("a decided candidate is not geocoded again", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const name = ownName();
      const versions = await namedIn(tx, name, [await insertTestSource(tx), await insertTestSource(tx)]);
      const runId = await textRun(tx, versions);
      const [id] = await collectNameCandidates(tx, runId, config);
      const { transport, seen } = nominatim([]);
      await geocodeCandidate(tx, id!, { transport, http: steppingClock() }, { runId, cfg: config });
      await tx.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.subjectId, id!));
      await tx.update(nameCandidates).set({ status: "decided" }).where(eq(nameCandidates.id, id!));

      // A third document arrives: the counters follow, but the candidate is neither planned nor searched again.
      const more = await namedIn(tx, name, [await insertTestSource(tx)]);
      expect(await collectNameCandidates(tx, await textRun(tx, more), config)).toEqual([]);
      expect(await candidateOf(tx, name)).toMatchObject({ documents: 3, sources: 3, status: "decided" });
      expect(await geocodeCandidate(tx, id!, { transport, http: steppingClock() }, { runId, cfg: config })).toBeNull();
      expect(seen).toHaveLength(1);

      // A collecting row whose task was decided counts as decided too.
      await tx.update(nameCandidates).set({ status: "collecting" }).where(eq(nameCandidates.id, id!));
      expect(await collectNameCandidates(tx, await textRun(tx, more), config)).toEqual([]);
      expect(await geocodeCandidate(tx, id!, { transport, http: steppingClock() }, { runId, cfg: config })).toBeNull();
      expect(seen).toHaveLength(1);
    }));

  it("no nominatim hit still opens a task", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const name = ownName();
      const versions = await namedIn(tx, name, [await insertTestSource(tx), await insertTestSource(tx)]);
      const runId = await textRun(tx, versions);
      const [id] = await collectNameCandidates(tx, runId, config);
      const result = await geocodeCandidate(tx, id!, { ...nominatim([]), http: steppingClock() }, { runId, cfg: config });

      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, id!));
      expect(result).toEqual({ hits: 0, taskId: task!.id });
      expect((task!.context as NameCandidateContext).hits).toEqual([]);
      expect((task!.context as NameCandidateContext).occurrences).toHaveLength(2);
      expect(await candidateOf(tx, name)).toMatchObject({ status: "review", geocode: [] });
    }));
});

describe("occurrenceSnippet", () => {
  it("cuts 150 characters around the name and points at it", () => {
    const text = `${"a".repeat(200)} Kolona ${"b".repeat(200)}`;
    const s = occurrenceSnippet(text, "Kolona");
    expect(s.snippet).toHaveLength(150 + 6 + 150);
    expect(s.snippet.slice(s.start, s.end)).toBe("Kolona");
    expect(occurrenceSnippet("in der bucht von kolona", "Kolona")).toEqual({ snippet: "in der bucht von kolona", start: 17, end: 23 });
    expect(occurrenceSnippet("nothing here", "Kolona")).toEqual({ snippet: "nothing here", start: 0, end: 0 });
  });
});
