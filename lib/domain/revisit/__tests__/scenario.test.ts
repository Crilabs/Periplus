import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { contentHash, normalizeMarkdown } from "@/lib/domain/documents/normalize";
import { ensureDocument, storeFetched } from "@/lib/domain/documents/store";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import {
  applyEdit,
  loadScenario,
  preflightScenario,
  revisitScenarioSchema,
  ScenarioEditAmbiguous,
  ScenarioEditNotApplicable,
  type RevisitScenario,
  type ScenarioEntry,
} from "../scenario";

const URL_A = "https://x.test.invalid/a";

function entry(over: Partial<ScenarioEntry> = {}): ScenarioEntry {
  return {
    id: "e1",
    url: URL_A,
    edit: { op: "replace", from: "ist im Sommer geöffnet.", to: "hat geschlossen." },
    expect: { document: "new_version", events: [{ subject: "sp_01J0000000000000000000000A", attribute: "highlight.food", type: "changed", severity: "notable" }] },
    ...over,
  };
}

describe("applyEdit", () => {
  it("an edit whose text is missing fails with url and text", () => {
    expect(() => applyEdit("Die Taverne ist offen.", { op: "delete", text: "Taverne Kostas" }, "https://x.test.invalid/a")).toThrow(
      /x\.test\.invalid\/a.*Taverne Kostas/s,
    );
    expect(() => applyEdit("Die Taverne ist offen.", { op: "delete", text: "Taverne Kostas" }, URL_A)).toThrow(ScenarioEditNotApplicable);
  });

  it("an edit matching twice is rejected", () => {
    const md = "Ankertiefe 4 m im Norden.\n\nAnkertiefe 4 m im Süden.\n";
    expect(() => applyEdit(md, { op: "replace", from: "Ankertiefe 4 m", to: "Ankertiefe 2 m" }, URL_A)).toThrow(ScenarioEditAmbiguous);
    expect(() => applyEdit(md, { op: "replace", from: "Ankertiefe 4 m", to: "Ankertiefe 2 m" }, URL_A)).toThrow(/Ankertiefe 4 m/);
  });

  it("replace tolerates line breaks inside the search text", () => {
    const md = "# Bucht\n\nDie Taverne Kostas ist im\nSommer geöffnet. Baden erlaubt.\n";
    expect(applyEdit(md, { op: "replace", from: "ist im Sommer   geöffnet.", to: "hat geschlossen." }, URL_A)).toBe(
      "# Bucht\n\nDie Taverne Kostas hat geschlossen. Baden erlaubt.\n",
    );
  });

  it("delete removes the text and keeps the rest", () => {
    expect(applyEdit("Guter Halt.\n\nBojen sind ausgelegt.\n\nTaverne.\n", { op: "delete", text: "Bojen sind ausgelegt." }, URL_A)).toBe(
      "Guter Halt.\n\n\n\nTaverne.\n",
    );
  });

  it("append adds a paragraph at the end", () => {
    expect(applyEdit("# Hafen\n\nSwimming is prohibited.\n\n", { op: "append", text: "Anchoring is prohibited in the harbour basin." }, URL_A)).toBe(
      "# Hafen\n\nSwimming is prohibited.\n\nAnchoring is prohibited in the harbour basin.\n",
    );
  });

  it("touch keeps the normalized content hash", () => {
    const md = "# Bucht\n\nGuter Halt in Sand.\n";
    const touched = applyEdit(md, { op: "touch" }, URL_A);
    expect(touched).not.toBe(md);
    expect(contentHash(normalizeMarkdown(touched))).toBe(contentHash(normalizeMarkdown(md)));
  });

  it("gone has no text to edit", () => {
    expect(() => applyEdit("x", { op: "gone" }, URL_A)).toThrow(/gone/);
  });
});

describe("revisitScenarioSchema", () => {
  it("accepts depth.* and null attributes, refuses other subjects", () => {
    const scenario = { name: "t", entries: [entry({ expect: { document: "new_version", events: [{ subject: "sp_1", attribute: "depth.*", type: "changed", severity: "safety" }] } })] };
    expect(revisitScenarioSchema.parse(scenario).entries).toHaveLength(1);
    const bad = { name: "t", entries: [entry({ expect: { document: "gone", events: [{ subject: "pl_1", attribute: null, type: "changed", severity: "info" }] } })] };
    expect(revisitScenarioSchema.safeParse(bad).success).toBe(false);
  });

  it("refuses duplicate ids and urls that normalize to the same", () => {
    expect(revisitScenarioSchema.safeParse({ name: "t", entries: [entry(), entry({ url: "https://x.test.invalid/b" })] }).success).toBe(false);
    const sameUrl = { name: "t", entries: [entry(), entry({ id: "e2", url: "https://X.test.invalid/a?utm_source=x#top" })] };
    expect(revisitScenarioSchema.safeParse(sameUrl).success).toBe(false);
  });

  it("loadScenario reads and validates a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scenario-"));
    const path = join(dir, "scenario.json");
    writeFileSync(path, JSON.stringify({ name: "fixture", entries: [entry()] }));
    expect((await loadScenario(path)).name).toBe("fixture");
    writeFileSync(path, JSON.stringify({ name: "fixture", entries: [{ id: "e1" }] }));
    await expect(loadScenario(path)).rejects.toThrow(/scenario/);
  });
});

async function recordedDocument(tx: Db, archive: ReturnType<typeof memoryArchive>, url: string, markdown: string) {
  const host = new URL(url).host;
  const [source] = await tx
    .insert(sources)
    .values({ domain: host, name: "Scenario test", type: "pilot_guide", weight: 0.9, status: "approved", crawlRules: {}, origin: "manual" })
    .returning({ id: sources.id });
  const doc = await ensureDocument(tx, { sourceId: source!.id, url, urlNormalized: url, docType: "pilot_guide" });
  await storeFetched(
    tx,
    archive,
    doc.id,
    {
      fetchedAt: new Date("2026-05-01T08:00:00Z"),
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
  return { sourceId: source!.id, documentId: doc.id };
}

describe("preflightScenario", () => {
  it("preflight rejects duplicate urls and unknown documents", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const url = `https://${newId().toLowerCase()}.test.invalid/a`;
      const { documentId } = await recordedDocument(tx, archive, url, "# Bucht\n\nDie Taverne Kostas ist im Sommer geöffnet.\n");
      const unknown = `https://${newId().toLowerCase()}.test.invalid/b`;
      const scenario: RevisitScenario = {
        name: "t",
        entries: [entry({ id: "e1", url }), entry({ id: "e2", url: `${url}?utm_source=x` }), entry({ id: "e3", url: unknown })],
      };
      const result = await preflightScenario(tx, archive, scenario);
      expect(result[0]).toEqual({ entryId: "e1", documentId, ok: true });
      expect(result[1]).toMatchObject({ entryId: "e2", ok: false, error: expect.stringMatching(/duplicate/) });
      expect(result[2]).toMatchObject({ entryId: "e3", documentId: null, ok: false, error: expect.stringMatching(/no document/) });
    }));

  it("reports an edit that does not apply to the recorded version", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const url = `https://${newId().toLowerCase()}.test.invalid/a`;
      await recordedDocument(tx, archive, url, "# Bucht\n\nGuter Halt.\n");
      const [r] = await preflightScenario(tx, archive, { name: "t", entries: [entry({ url })] });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/ist im Sommer geöffnet/) });
      const [gone] = await preflightScenario(tx, archive, { name: "t", entries: [entry({ url, edit: { op: "gone" } })] });
      expect(gone!.ok).toBe(true);
    }));
});
