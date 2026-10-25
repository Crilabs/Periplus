import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { sources, type SourceStatus } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { getSource } from "@/lib/domain/sources/store";
import { insertPlace, insertTextFact } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

const db = testDb();
/** What getDb() returns; each test points it at its rollback transaction (no source is ever committed). */
let currentDb: Db = db;
const requireAdmin = vi.fn();
const redirect = vi.fn();
let archive = memoryArchive();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
/** The job queue cannot be reached (getBoss throws), e.g. right after an upload committed. */
let bossDown = false;
// Jobs are only collected: no worker runs.
vi.mock("@/lib/jobs/boss", () => ({
  getBoss: async () => {
    if (bossDown) throw new Error("queue down");
    return { insert: async (_queue: string, jobs: Array<{ id: string }>) => jobs.map((j) => j.id) };
  },
}));
vi.mock("@/lib/adapters/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters/s3")>()),
  getArchive: () => archive,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
  // Like the real one, it ends the action.
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { createSourceAction } from "../sources/actions";
import { endSourceAction, pauseSourceAction, saveSourceAction } from "../sources/[id]/actions";

const ADMIN = "admin@example.invalid";

const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

async function insertSource(tx: Db, status: SourceStatus = "approved", validTo: string | null = null): Promise<string> {
  const domain = `${newId()}.test.invalid`;
  const [row] = await tx
    .insert(sources)
    .values({ domain, name: domain, type: "forum", weight: 0.4, status, crawlRules: DEFAULT_CRAWL_RULES, origin: "manual", validTo })
    .returning({ id: sources.id });
  return row!.id;
}

/** The settings form as the source page renders it. */
const settingsForm = (sourceId: string, overrides: Record<string, string> = {}) =>
  form({
    sourceId,
    name: "Neuer Name",
    type: "marina",
    weight: "0.7",
    changeRate: "high",
    startUrls: "",
    allow: "^/bays/",
    deny: "",
    maxDepth: "3",
    maxPages: "500",
    ratePerMinute: "20",
    render: "auto",
    converter: "auto",
    pdf: "on",
    boilerplateSelectors: "",
    ...overrides,
  });

beforeEach(() => {
  vi.resetAllMocks();
  bossDown = false;
  currentDb = db;
  archive = memoryArchive();
  requireAdmin.mockResolvedValue({ email: ADMIN });
});

describe("saveSourceAction", () => {
  it("saveSourceAction rejects weight 1.5", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      const before = await getSource(tx, sourceId);
      await saveSourceAction(settingsForm(sourceId, { weight: "1.5", deny: "(unclosed" }));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?invalid=weight,deny`);
      expect(await getSource(tx, sourceId)).toEqual(before);
    }));

  it("an invalid boilerplate selector comes back as invalid and saves nothing", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      const before = await getSource(tx, sourceId);
      await saveSourceAction(settingsForm(sourceId, { boilerplateSelectors: ".nav\ndiv >> p" }));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?invalid=boilerplateSelectors`);
      expect(await getSource(tx, sourceId)).toEqual(before);
    }));

  it("a blank weight is invalid, not 0", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      await saveSourceAction(settingsForm(sourceId, { weight: "  " }));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?invalid=weight`);
    }));

  it("saves valid settings", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      await saveSourceAction(settingsForm(sourceId));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?saved=1`);
      expect(await getSource(tx, sourceId)).toMatchObject({
        name: "Neuer Name",
        type: "marina",
        weight: expect.closeTo(0.7, 5),
        changeRate: "high",
        crawlRules: { allow: ["^/bays/"] },
      });
    }));

  it("an ended source is not saved", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx, "approved", "2026-01-01");
      const before = await getSource(tx, sourceId);
      await saveSourceAction(settingsForm(sourceId));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?error=source_ended`);
      expect(await getSource(tx, sourceId)).toEqual(before);
    }));

  it("a malformed source id is a 404, not a server error", async () => {
    await expect(saveSourceAction(settingsForm("not-a-uuid"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(pauseSourceAction(form({ sourceId: "1; drop" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("rejects without admin session", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      requireAdmin.mockRejectedValue(new Error("unauthorized"));
      await expect(saveSourceAction(settingsForm(sourceId))).rejects.toThrow("unauthorized");
      expect((await getSource(tx, sourceId))!.name).not.toBe("Neuer Name");
    }));
});

describe("endSourceAction (ruling M6-H-R1)", () => {
  it("ends an approved source and says how many objects had facts from it", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      const { objectId } = await insertPlace(tx, { name: "Quellenbucht" });
      await insertTextFact(tx, objectId, sourceId, { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      await endSourceAction(form({ sourceId }));
      expect(requireAdmin).toHaveBeenCalled();
      expect((await getSource(tx, sourceId))!.validTo).not.toBeNull();
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?ended=1`);
    }));

  it("a source without facts ends without a run; a proposed or ended one is refused; a bad id is a 404", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const paused = await insertSource(tx, "paused");
      await endSourceAction(form({ sourceId: paused }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${paused}?ended=0`);
      const proposed = await insertSource(tx, "proposed");
      await endSourceAction(form({ sourceId: proposed }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${proposed}?error=not_endable`);
      expect((await getSource(tx, proposed))!.validTo).toBeNull();
      await endSourceAction(form({ sourceId: paused }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${paused}?error=not_endable`);
      await expect(endSourceAction(form({ sourceId: "not-a-uuid" }))).rejects.toThrow("NEXT_NOT_FOUND");
    }));

  it("rejects without admin session", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      requireAdmin.mockRejectedValue(new Error("not an admin"));
      await expect(endSourceAction(form({ sourceId }))).rejects.toThrow("not an admin");
      expect((await getSource(tx, sourceId))!.validTo).toBeNull();
    }));
});

describe("status actions", () => {
  it("pausing a proposed source redirects with an error and changes nothing", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx, "proposed");
      await pauseSourceAction(form({ sourceId }));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?error=not_approved`);
      expect((await getSource(tx, sourceId))!.status).toBe("proposed");
    }));
});

describe("createSourceAction", () => {
  it("creates an approved manual source and refuses its domain a second time", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const domain = `m${newId()}.com`;
      await createSourceAction(form({ domain: `https://www.${domain}/`, name: "Handbuch", type: "pilot_guide" }));
      const [row] = await tx.select().from(sources).where(eq(sources.domain, domain));
      expect(row).toMatchObject({ status: "approved", origin: "manual", name: "Handbuch" });
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${row!.id}`);

      await createSourceAction(form({ domain, name: "Nochmal", type: "forum" }));
      expect(redirect).toHaveBeenLastCalledWith("/sources?error=domain_known");
      await createSourceAction(form({ domain: "kein domain", name: "X", type: "forum" }));
      expect(redirect).toHaveBeenLastCalledWith("/sources?error=invalid_domain");
      await createSourceAction(form({ domain: "https://fr.navily.com/", name: "Navily", type: "forum" }));
      expect(redirect).toHaveBeenLastCalledWith("/sources?error=forbidden_domain");
    }));
});

