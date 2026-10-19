import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db/client";
import { reviewDecisions, reviewTasks, sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createReviewTask } from "@/lib/domain/review";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { getSource } from "@/lib/domain/sources/store";
import { testDb, withRollback } from "@/test/db";

const db = testDb();
/** What getDb() returns; each test points it at its rollback transaction (no source is ever committed). */
let currentDb: Db = db;
const requireAdmin = vi.fn();
const redirect = vi.fn();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { parseCrawlRulesForm } from "../_components/crawl-rules-fields";
import { approveSourceAction } from "../review/[id]/actions";

const ADMIN = "admin@example.invalid";

/** A complete crawl rules form as CrawlRulesFields renders it (the `pdf` checkbox sends "on" when checked). */
function rulesForm(overrides: Record<string, string | null> = {}): FormData {
  const fields: Record<string, string | null> = {
    startUrls: "https://example.test.invalid/guide/\r\nhttps://example.test.invalid/bays/",
    allow: "^/guide/\n\n  ^/bays/  \n",
    deny: "/tag/",
    maxDepth: "2",
    maxPages: "100",
    ratePerMinute: "10",
    render: "never",
    converter: "local",
    pdf: "on",
    boilerplateSelectors: ".cookie-banner",
    ...overrides,
  };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null) form.set(k, v);
  return form;
}

async function proposal(tx: Db): Promise<{ sourceId: string; taskId: string }> {
  const domain = `${newId()}.test.invalid`;
  const [row] = await tx
    .insert(sources)
    .values({
      domain,
      name: domain,
      type: "trip_report",
      weight: 0.6,
      crawlRules: DEFAULT_CRAWL_RULES,
      origin: "serp",
    })
    .returning({ id: sources.id });
  const { id } = await createReviewTask(tx, {
    kind: "source_approval",
    subjectType: "source",
    subjectId: row!.id,
    context: {},
  });
  return { sourceId: row!.id, taskId: id };
}

beforeEach(() => {
  vi.resetAllMocks();
  currentDb = db;
  requireAdmin.mockResolvedValue({ email: ADMIN });
});

describe("parseCrawlRulesForm", () => {
  it("parseCrawlRulesForm reads one allow pattern per line", () => {
    expect(parseCrawlRulesForm(rulesForm())).toEqual({
      startUrls: ["https://example.test.invalid/guide/", "https://example.test.invalid/bays/"],
      allow: ["^/guide/", "^/bays/"],
      deny: ["/tag/"],
      maxDepth: 2,
      maxPages: 100,
      ratePerMinute: 10,
      render: "never",
      converter: "local",
      pdf: true,
      boilerplateSelectors: [".cookie-banner"],
    });
  });

  it("an unchecked pdf box and empty lists are false and empty", () => {
    expect(parseCrawlRulesForm(rulesForm({ pdf: null, allow: "", boilerplateSelectors: "\n" }))).toMatchObject({
      pdf: false,
      allow: [],
      boilerplateSelectors: [],
    });
  });

  it("reports errors per field", () => {
    let error: unknown;
    try {
      parseCrawlRulesForm(rulesForm({ deny: "/ok/\n(unclosed", maxPages: "0", render: null, maxDepth: "" }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ZodError);
    const fields = new Set((error as ZodError).issues.map((i) => i.path[0]));
    expect(fields).toEqual(new Set(["deny", "maxPages", "render", "maxDepth"]));
  });
});

describe("approveSourceAction", () => {
  const approveForm = (taskId: string, overrides: Record<string, string | null> = {}) => {
    const form = rulesForm(overrides);
    const fields = { taskId, type: "pilot_guide", weight: "0.85", changeRate: "static", ...overrides };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) form.delete(k);
      else form.set(k, v);
    }
    return form;
  };

  it("approves the source with the form values and moves on", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const { sourceId, taskId } = await proposal(tx);
      await approveSourceAction(approveForm(taskId));

      expect(redirect).toHaveBeenCalledTimes(1);
      expect(redirect.mock.calls[0]![0]).not.toContain(taskId);
      expect(await getSource(tx, sourceId)).toMatchObject({
        status: "approved",
        type: "pilot_guide",
        weight: 0.85,
        changeRate: "static",
        crawlRules: { allow: ["^/guide/", "^/bays/"], maxPages: 100, render: "never" },
      });
      const decisions = await tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, taskId));
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ decidedBy: ADMIN, decision: { action: "approve", type: "pilot_guide" } });
    }));

  it("invalid fields redirect back naming them and write nothing", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const { sourceId, taskId } = await proposal(tx);
      await approveSourceAction(approveForm(taskId, { deny: "(unclosed", weight: "2" }));

      expect(redirect).toHaveBeenCalledWith(`/review/${taskId}?invalid=weight,deny`);
      expect((await getSource(tx, sourceId))!.status).toBe("proposed");
      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.id, taskId));
      expect(task!.status).toBe("open");
    }));

  it("a source that is no longer proposed redirects with an error", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const { sourceId, taskId } = await proposal(tx);
      await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, sourceId));
      await approveSourceAction(approveForm(taskId));
      expect(redirect).toHaveBeenCalledWith(`/review/${taskId}?error=1`);
    }));

  it("rejects without admin session", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const { sourceId, taskId } = await proposal(tx);
      requireAdmin.mockRejectedValue(new Error("unauthorized"));
      await expect(approveSourceAction(approveForm(taskId))).rejects.toThrow("unauthorized");
      expect((await getSource(tx, sourceId))!.status).toBe("proposed");
    }));
});
