import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConverters } from "@/lib/adapters/fetch";
import { createSimulatedFetcher, SimulationNetworkError, simulatedTransport } from "@/lib/adapters/fetch/simulated";
import { httpCall, type Transport } from "@/lib/adapters/http";
import { setSimulationMode } from "@/lib/adapters/simulation";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { crawlFrontier, documents, documentVersions, sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { ensureDocument, storeFetched } from "@/lib/domain/documents/store";
import { createRun } from "@/lib/domain/runs";
import { preflightScenario, type RevisitScenario, type ScenarioEdit } from "@/lib/domain/revisit/scenario";
import { prepareSourceCrawl } from "@/lib/pipeline/fetch/source";
import { FETCH_RUN_STAGES } from "@/lib/pipeline/fetch/run";
import { FETCH_URL_STAGE, fetchUrl, type FetchUrlDeps } from "@/lib/pipeline/fetch/url";
import { simulatedFetcherFor } from "@/lib/jobs/handlers/fetch";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

// Every network transport refuses: the simulated fetch must answer without one.
const noNetwork: Transport = async (req) => {
  throw new Error(`unexpected request ${req.url}`);
};

beforeEach(() => setSimulationMode(true));
afterEach(() => setSimulationMode(undefined));

const RECORDED = "# Bucht\n\nDie Taverne Kostas ist im Sommer geöffnet.\n\nGuter Halt in Sand auf 5 m.\n";

type Fixture = { sourceId: string; host: string; docs: Record<string, { id: string; url: string }> };

/** A source on its own `*.test.invalid` host with one recorded (non-simulated) version per page. */
async function seed(tx: Db, archive: ReturnType<typeof memoryArchive>, pages: string[]): Promise<Fixture> {
  // Its own registrable domain (`<id>.invalid`), so the crawl rules allow its URLs.
  const host = `${newId().toLowerCase()}.invalid`;
  const [source] = await tx
    .insert(sources)
    .values({ domain: host, name: "Sim test", type: "pilot_guide", weight: 0.9, status: "approved", crawlRules: { render: "never" }, origin: "manual" })
    .returning({ id: sources.id });
  const docs: Fixture["docs"] = {};
  for (const page of pages) {
    const url = `https://${host}/${page}`;
    const doc = await ensureDocument(tx, { sourceId: source!.id, url, urlNormalized: url, docType: "pilot_guide" });
    await tx.insert(crawlFrontier).values({ sourceId: source!.id, url, urlNormalized: url, status: "fetched" });
    await storeFetched(
      tx,
      archive,
      doc.id,
      {
        fetchedAt: new Date("2026-05-01T08:00:00Z"),
        raw: new TextEncoder().encode(`<html><body>${page}</body></html>`),
        rawExt: "html",
        contentType: "text/html",
        finalUrl: null,
        markdown: RECORDED,
        converter: "local",
        language: "de",
        publishedAt: null,
        docType: "pilot_guide",
        etag: null,
        lastModified: null,
      },
      getConfig().fetch.chunk,
    );
    docs[page] = { id: doc.id, url };
  }
  return { sourceId: source!.id, host, docs };
}

function scenarioOf(entries: Array<{ url: string; edit: ScenarioEdit }>): RevisitScenario {
  return {
    name: "test",
    entries: entries.map((e, i) => ({
      id: `e${i + 1}`,
      url: e.url,
      edit: e.edit,
      expect: { document: e.edit.op === "gone" ? "gone" : e.edit.op === "touch" ? "unchanged" : "new_version", events: [] },
    })),
  };
}

function simDeps(archive: ReturnType<typeof memoryArchive>, scenario: RevisitScenario): FetchUrlDeps {
  return {
    transport: noNetwork,
    archive,
    converters: createConverters({ transport: noNetwork, cfg: getConfig().fetch }),
    pdf: { pdftotext: async () => "" },
    enqueue: async () => {
      throw new Error("a simulated fetch discovers no links");
    },
    simulated: createSimulatedFetcher(scenario),
    now: () => new Date("2026-06-01T08:00:00Z"),
  };
}

async function fetchOnce(tx: Db, fx: Fixture, url: string, deps: FetchUrlDeps) {
  const { id: runId } = await createRun(tx, {
    kind: "stage",
    scope: { type: "source", id: fx.sourceId },
    stages: FETCH_RUN_STAGES,
    params: { sourceIds: [fx.sourceId] },
    triggeredBy: "test",
  });
  return fetchUrl(tx, { sourceId: fx.sourceId, url, depth: 0 }, deps, { db: tx, runId, stage: FETCH_URL_STAGE });
}

const versionsOf = (tx: Db, documentId: string) =>
  tx.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)).orderBy(asc(documentVersions.fetchedAt));

describe("simulated fetch", () => {
  it("a scenario url gets a simulated version with converter simulated", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a"]);
      const scenario = scenarioOf([{ url: fx.docs.a!.url, edit: { op: "replace", from: "ist im Sommer geöffnet.", to: "hat geschlossen." } }]);
      const deps = simDeps(archive, scenario);

      expect(await fetchOnce(tx, fx, fx.docs.a!.url, deps)).toEqual({ outcome: "new_version", newUrls: 0 });
      const versions = await versionsOf(tx, fx.docs.a!.id);
      expect(versions).toHaveLength(2);
      const sim = versions[1]!;
      expect(sim).toMatchObject({ simulated: true, converter: "simulated", contentType: "text/markdown", docType: "pilot_guide" });
      expect(sim.rawKey).toMatch(/\.raw\.md$/);
      const md = new TextDecoder().decode((await archive.get(sim.mdKey))!);
      expect(md).toContain("Die Taverne Kostas hat geschlossen.");
      expect(md).toContain("Guter Halt in Sand auf 5 m.");
      const [doc] = await tx.select().from(documents).where(eq(documents.id, fx.docs.a!.id));
      expect(doc!.currentVersionId).toBe(sim.id);

      // A second fetch edits the recorded version again: same content, no second version, preflight still passes.
      expect(await fetchOnce(tx, fx, fx.docs.a!.url, deps)).toEqual({ outcome: "unchanged", newUrls: 0 });
      expect(await versionsOf(tx, fx.docs.a!.id)).toHaveLength(2);
      expect((await preflightScenario(tx, archive, scenario))[0]!.ok).toBe(true);
    }));

  it("an append is applied once, also on the second fetch", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a"]);
      const deps = simDeps(archive, scenarioOf([{ url: fx.docs.a!.url, edit: { op: "append", text: "Anchoring is prohibited." } }]));
      expect((await fetchOnce(tx, fx, fx.docs.a!.url, deps)).outcome).toBe("new_version");
      expect((await fetchOnce(tx, fx, fx.docs.a!.url, deps)).outcome).toBe("unchanged");
      const versions = await versionsOf(tx, fx.docs.a!.id);
      const md = new TextDecoder().decode((await archive.get(versions.at(-1)!.mdKey))!);
      expect(md.match(/Anchoring is prohibited\./g)).toHaveLength(1);
    }));

  it("a non-scenario url is not modified and makes no request", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a", "b"]);
      const deps = simDeps(archive, scenarioOf([{ url: fx.docs.a!.url, edit: { op: "touch" } }]));
      expect(await fetchOnce(tx, fx, fx.docs.b!.url, deps)).toEqual({ outcome: "not_modified", newUrls: 0 });
      expect(await versionsOf(tx, fx.docs.b!.id)).toHaveLength(1);
      const [doc] = await tx.select().from(documents).where(eq(documents.id, fx.docs.b!.id));
      expect(doc!.lastCheckedAt).toEqual(new Date("2026-06-01T08:00:00Z"));
    }));

  it("a gone entry marks the document gone after two fetches", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a"]);
      const deps = simDeps(archive, scenarioOf([{ url: fx.docs.a!.url, edit: { op: "gone" } }]));
      expect((await fetchOnce(tx, fx, fx.docs.a!.url, deps)).outcome).toBe("missing");
      expect((await fetchOnce(tx, fx, fx.docs.a!.url, deps)).outcome).toBe("gone");
      const [doc] = await tx.select().from(documents).where(eq(documents.id, fx.docs.a!.id));
      expect(doc!.status).toBe("gone");
      expect(await versionsOf(tx, fx.docs.a!.id)).toHaveLength(1);
    }));

  it("a touched page stays unchanged", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a"]);
      const deps = simDeps(archive, scenarioOf([{ url: fx.docs.a!.url, edit: { op: "touch" } }]));
      expect(await fetchOnce(tx, fx, fx.docs.a!.url, deps)).toEqual({ outcome: "unchanged", newUrls: 0 });
      expect(await versionsOf(tx, fx.docs.a!.id)).toHaveLength(1);
    }));

  it("a page recorded as gone answers 404 again, a page never recorded is skipped", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a", "b"]);
      await tx.update(documents).set({ status: "gone", consecutiveGone: 2 }).where(eq(documents.id, fx.docs.b!.id));
      const deps = simDeps(archive, scenarioOf([{ url: fx.docs.a!.url, edit: { op: "touch" } }]));
      expect((await fetchOnce(tx, fx, fx.docs.b!.url, deps)).outcome).toBe("missing");
      const [doc] = await tx.select().from(documents).where(eq(documents.id, fx.docs.b!.id));
      expect(doc).toMatchObject({ status: "gone", consecutiveGone: 3 });
      expect(await fetchOnce(tx, fx, `https://${fx.host}/never`, deps)).toEqual({ outcome: "skipped", newUrls: 0 });
    }));

  it("preflight refuses a simulated version that differs from the edited text", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a"]);
      const url = fx.docs.a!.url;
      await fetchOnce(tx, fx, url, simDeps(archive, scenarioOf([{ url, edit: { op: "append", text: "Erste Fassung." } }])));
      const changed = scenarioOf([{ url, edit: { op: "append", text: "Zweite Fassung." } }]);
      expect((await preflightScenario(tx, archive, changed))[0]).toMatchObject({ ok: false, error: expect.stringMatching(/hat eine simulierte aktuelle Version, die nicht diese Änderung/) });
    }));

  it("edits the current version after a revert A -> B -> A, not the newest by fetch time", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a"]);
      const { id, url } = fx.docs.a!;
      // B adds a paragraph; the page then went back to A (storeFetched points current_version_id at A's old row).
      await record(tx, archive, id, `${RECORDED}\nEin Absatz nur in B.\n`, "2026-05-02T08:00:00Z");
      await record(tx, archive, id, RECORDED, "2026-05-03T08:00:00Z");
      const scenario = scenarioOf([{ url, edit: { op: "replace", from: "ist im Sommer geöffnet.", to: "hat geschlossen." } }]);
      expect((await preflightScenario(tx, archive, scenario))[0]!.ok).toBe(true);
      expect((await fetchOnce(tx, fx, url, simDeps(archive, scenario))).outcome).toBe("new_version");
      const [doc] = await tx.select().from(documents).where(eq(documents.id, id));
      const [sim] = await tx.select().from(documentVersions).where(eq(documentVersions.id, doc!.currentVersionId!));
      expect(sim!.simulated).toBe(true);
      const md = new TextDecoder().decode((await archive.get(sim!.mdKey))!);
      expect(md).toBe(RECORDED.replace("ist im Sommer geöffnet.", "hat geschlossen."));
      // The second fetch answers the simulated current version as it is.
      expect((await fetchOnce(tx, fx, url, simDeps(archive, scenario))).outcome).toBe("unchanged");
    }));

  it("a non-scenario page recorded with one miss is reset by the 304", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a", "b"]);
      await tx.update(documents).set({ consecutiveGone: 1 }).where(eq(documents.id, fx.docs.b!.id));
      const deps = simDeps(archive, scenarioOf([{ url: fx.docs.a!.url, edit: { op: "touch" } }]));
      expect((await fetchOnce(tx, fx, fx.docs.b!.url, deps)).outcome).toBe("not_modified");
      const [doc] = await tx.select().from(documents).where(eq(documents.id, fx.docs.b!.id));
      expect(doc).toMatchObject({ status: "active", consecutiveGone: 0 });
    }));

  it("a gone entry recorded with one miss turns gone at the first simulated fetch", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a"]);
      await tx.update(documents).set({ consecutiveGone: 1 }).where(eq(documents.id, fx.docs.a!.id));
      const deps = simDeps(archive, scenarioOf([{ url: fx.docs.a!.url, edit: { op: "gone" } }]));
      expect((await fetchOnce(tx, fx, fx.docs.a!.url, deps)).outcome).toBe("gone");
    }));

  it("the source preparation reads robots.txt from the simulated transport", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const fx = await seed(tx, archive, ["a"]);
      await tx.update(sources).set({ crawlRules: { render: "never", startUrls: [fx.docs.a!.url] } }).where(eq(sources.id, fx.sourceId));
      const { id: runId } = await createRun(tx, {
        kind: "stage",
        scope: { type: "source", id: fx.sourceId },
        stages: FETCH_RUN_STAGES,
        params: { sourceIds: [fx.sourceId] },
        triggeredBy: "test",
      });
      const prepared = await prepareSourceCrawl(tx, fx.sourceId, { transport: simulatedTransport, archive }, { db: tx, runId, stage: "fetch.source" });
      expect(prepared).toMatchObject({ status: "ready", startUrls: 1, robots: { status: "allow_all" } });
    }));
});

describe("simulatedTransport", () => {
  it("answers robots.txt with 404 and refuses everything else", () =>
    withRollback(async (tx) => {
      const robots = await httpCall(
        simulatedTransport,
        { service: "crawl", operation: "robots", url: "https://x.test.invalid/robots.txt", timeoutMs: 1000, okStatuses: [404] },
        { db: tx },
      );
      expect(robots.status).toBe(404);
      await expect(
        httpCall(simulatedTransport, { service: "crawl", operation: "page", url: "https://x.test.invalid/a", timeoutMs: 1000 }, { db: tx }),
      ).rejects.toBeInstanceOf(SimulationNetworkError);
    }));
});

describe("simulatedFetcherFor", () => {
  it("is null without a simulation and caches the scenario by path and content", async () => {
    expect(await simulatedFetcherFor({ PERIPLUS_SIMULATION: undefined })).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "sim-scenario-"));
    const path = join(dir, "scenario.json");
    const loaded: string[] = [];
    const onLoad = (l: { name: string }) => loaded.push(l.name);
    writeFileSync(path, JSON.stringify(scenarioOf([{ url: "https://x.test.invalid/a", edit: { op: "gone" } }])));
    const first = await simulatedFetcherFor({ PERIPLUS_SIMULATION: path }, onLoad);
    expect(await simulatedFetcherFor({ PERIPLUS_SIMULATION: path }, onLoad)).toBe(first);
    expect(first!.respond("https://x.test.invalid/a", null)).toEqual({ status: 404 });
    expect(first!.respond("https://x.test.invalid/b", null)).toEqual({ status: 304 });
    expect(loaded).toEqual(["test"]);

    // An entry added while the worker keeps running is answered at once, not as 304 from the old scenario.
    writeFileSync(
      path,
      JSON.stringify(scenarioOf([{ url: "https://x.test.invalid/a", edit: { op: "gone" } }, { url: "https://x.test.invalid/b", edit: { op: "gone" } }])),
    );
    const second = await simulatedFetcherFor({ PERIPLUS_SIMULATION: path }, onLoad);
    expect(second).not.toBe(first);
    expect(second!.respond("https://x.test.invalid/b", null)).toEqual({ status: 404 });
    expect(loaded).toHaveLength(2);

    // An invalid edit is not kept: the job fails, and the fixed file is read again.
    writeFileSync(path, "{");
    await expect(simulatedFetcherFor({ PERIPLUS_SIMULATION: path })).rejects.toThrow(/scenario/);
    writeFileSync(path, JSON.stringify(scenarioOf([{ url: "https://x.test.invalid/a", edit: { op: "gone" } }])));
    expect((await simulatedFetcherFor({ PERIPLUS_SIMULATION: path }))!.respond("https://x.test.invalid/b", null)).toEqual({ status: 304 });
  });
});

async function record(tx: Db, archive: ReturnType<typeof memoryArchive>, documentId: string, markdown: string, at: string) {
  await storeFetched(
    tx,
    archive,
    documentId,
    {
      fetchedAt: new Date(at),
      raw: new TextEncoder().encode(markdown),
      rawExt: "md",
      contentType: "text/markdown",
      finalUrl: null,
      markdown,
      converter: "local",
      language: "de",
      publishedAt: null,
      docType: "pilot_guide",
      etag: null,
      lastModified: null,
    },
    getConfig().fetch.chunk,
  );
}
