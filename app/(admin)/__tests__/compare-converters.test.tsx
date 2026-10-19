import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { converterOutputs, converterSamples, sources } from "@/lib/db/schema";
import { comparisonMdKey } from "@/lib/domain/converter-comparison";
import { newId } from "@/lib/domain/ids";
import { testDb, withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

let currentDb: Db = testDb();
const redirect = vi.fn();
const archive = memoryArchive();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: async () => ({ email: "admin@example.invalid" }) }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
vi.mock("@/lib/adapters/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters/s3")>()),
  getArchive: () => archive,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url), notFound: vi.fn() }));

import Page from "../compare/converters/page";
import { rateOutputAction } from "../compare/converters/actions";

/** A sample whose local and Jina outputs succeeded and whose Firecrawl output failed. */
async function insertSample(tx: Db) {
  const domain = `${newId()}.test.invalid`;
  const [source] = await tx
    .insert(sources)
    .values({ domain, name: domain, type: "forum", weight: 0.4, status: "approved", crawlRules: {}, origin: "manual" })
    .returning({ id: sources.id });
  const url = `https://${domain}/bay`;
  const [sample] = await tx.insert(converterSamples).values({ sourceId: source!.id, url, urlNormalized: url }).returning({ id: converterSamples.id });
  const sampleId = sample!.id;
  for (const converter of ["local", "jina"] as const) {
    await archive.put(comparisonMdKey(sampleId, converter), `## Markdown von ${converter}`, "text/markdown");
    await tx.insert(converterOutputs).values({ sampleId, converter, mdKey: comparisonMdKey(sampleId, converter), chars: 20, durationMs: 1500 });
  }
  await tx.insert(converterOutputs).values({ sampleId, converter: "firecrawl", error: "HTTP 403" });
  return { sampleId, domain, url };
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(searchParams) } as PageProps<"/compare/converters">));
}

beforeEach(() => {
  currentDb = testDb();
  redirect.mockReset();
});

describe("converter comparison page", () => {
  it("shows the decision, the progress, the pages and a sample in three columns with rating forms", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const { sampleId, url } = await insertSample(tx);
      const list = await render();
      expect(list).toContain("Vorläufig");
      expect(list).toContain(">Vergleich starten<");
      expect(list).toMatch(/0 von 50<\/strong> bewertet/);
      expect(list).toContain(`href="/compare/converters?sample=${sampleId}"`);
      expect(list).not.toContain("Seitenansicht");

      const page = await render({ sample: sampleId });
      expect(page).toContain(url);
      expect(page).toContain("<h2>Markdown von local</h2>");
      expect(page).toContain("<h2>Markdown von jina</h2>");
      expect(page).toContain("Fehler: HTTP 403");
      expect(page.match(/>Speichern</g)).toHaveLength(2);
      expect(page.match(/name="mainContent"/g)).toHaveLength(2);
    }));

  it("saves a column's rating; an unrated output of a failed conversion is refused", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const { sampleId } = await insertSample(tx);
      await rateOutputAction(form({ sampleId, converter: "local", mainContent: "on", tablesKept: "" }));
      expect(redirect).toHaveBeenLastCalledWith(`/compare/converters?sample=${sampleId}#local`);
      await rateOutputAction(form({ sampleId, converter: "jina", boilerplateRemoved: "on", tablesKept: "no" }));
      const rows = await tx.select().from(converterOutputs).where(eq(converterOutputs.sampleId, sampleId));
      expect(rows.find((r) => r.converter === "local")).toMatchObject({
        rating: { mainContent: true, boilerplateRemoved: false, tablesKept: null },
        ratedBy: "admin@example.invalid",
      });
      expect(rows.find((r) => r.converter === "jina")!.rating).toEqual({ mainContent: false, boilerplateRemoved: true, tablesKept: false });

      await rateOutputAction(form({ sampleId, converter: "firecrawl", mainContent: "on", tablesKept: "" }));
      expect(redirect).toHaveBeenLastCalledWith(`/compare/converters?sample=${sampleId}&error=not_rateable`);
      // An invalid rating returns to the open page when its sample id is valid, else to the list.
      await rateOutputAction(form({ sampleId, converter: "other", tablesKept: "" }));
      expect(redirect).toHaveBeenLastCalledWith(`/compare/converters?sample=${sampleId}&error=invalid_rating`);
      await rateOutputAction(form({ sampleId: "not-a-uuid", converter: "local", tablesKept: "" }));
      expect(redirect).toHaveBeenLastCalledWith("/compare/converters?error=invalid_rating");
      const after = await render({ sample: sampleId, error: "not_rateable" });
      expect(after).toContain("lässt sich nicht bewerten");
      // Both successful outputs rated, the failed one needs none: the page counts as rated.
      expect(after).toMatch(/1 von 50<\/strong> bewertet/);
    }));
});
