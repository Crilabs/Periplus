import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { documents, documentVersions, restrictedAreas, sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import type { Db } from "@/lib/db/client";
import { withRollback } from "@/test/db";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    // savepoint, so the surrounding transaction survives the expected failure
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

const testDomain = () => `${newId()}.test.invalid`;

async function insertSource(tx: Db, values: Partial<PgInsertValue<typeof sources>> = {}): Promise<string> {
  const [row] = await tx
    .insert(sources)
    .values({
      domain: testDomain(),
      name: "Test source",
      type: "pilot_guide",
      weight: 0.9,
      crawlRules: { startUrls: [] },
      origin: "manual",
      ...values,
    })
    .returning({ id: sources.id });
  return row!.id;
}

async function insertDocument(tx: Db, sourceId?: string): Promise<string> {
  const url = `https://${testDomain()}/page`;
  const [row] = await tx
    .insert(documents)
    .values({ sourceId: sourceId ?? (await insertSource(tx)), url, urlNormalized: url, docType: "pilot_guide" })
    .returning({ id: documents.id });
  return row!.id;
}

function versionValues(
  documentId: string,
  values: Partial<PgInsertValue<typeof documentVersions>> = {},
): PgInsertValue<typeof documentVersions> {
  return {
    documentId,
    fetchedAt: new Date("2026-10-19T10:00:00Z"),
    contentHash: "c1",
    rawHash: "r1",
    rawKey: `archive/${documentId}/raw.html`,
    mdKey: `archive/${documentId}/raw.md`,
    contentType: "text/html",
    finalUrl: "https://example.test.invalid/page",
    observedAt: "2026-10-19",
    observedAtBasis: "fetched",
    docType: "pilot_guide",
    converter: "local",
    charCount: 42,
    ...values,
  };
}

async function insertVersion(tx: Db): Promise<string> {
  const documentId = await insertDocument(tx);
  const [row] = await tx.insert(documentVersions).values(versionValues(documentId)).returning({ id: documentVersions.id });
  return row!.id;
}

describe("archive schema", () => {
  it("document_versions rejects DELETE", async () => {
    await withRollback(async (tx) => {
      const id = await insertVersion(tx);
      const message = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`delete from document_versions where id = ${id}`),
      );
      expect(message).toMatch(/document_versions is append-only/);
    });
  });

  it("document_versions accepts null content_type and final_url", async () => {
    await withRollback(async (tx) => {
      const documentId = await insertDocument(tx);
      const [row] = await tx
        .insert(documentVersions)
        .values(versionValues(documentId, { contentType: null, finalUrl: null }))
        .returning({ contentType: documentVersions.contentType, finalUrl: documentVersions.finalUrl });
      expect(row).toEqual({ contentType: null, finalUrl: null });
    });
  });

  it("document_versions rejects UPDATE", async () => {
    await withRollback(async (tx) => {
      const id = await insertVersion(tx);
      const message = await rejectionMessage(tx, (sp) =>
        sp.update(documentVersions).set({ charCount: 1 }).where(eq(documentVersions.id, id)),
      );
      expect(message).toMatch(/document_versions is append-only/);
    });
  });

  it.each([
    ["sources", insertSource],
    ["documents", insertDocument],
  ] as const)("%s can be deleted again (no delete guard since N6, design 7.2)", async (table, insert) => {
    await withRollback(async (tx) => {
      const id = await insert(tx);
      await tx.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`);
    });
  });

  it("no history tables and no history or delete-guard functions remain", async () => {
    await withRollback(async (tx) => {
      const tables = await tx.execute<{ n: string }>(sql`
        select tablename as n from pg_tables where schemaname = current_schema() and tablename like '%\_history'`);
      expect(tables.rows).toEqual([]);
      const fns = await tx.execute<{ n: string }>(sql`
        select proname as n from pg_proc where pronamespace = current_schema()::regnamespace
          and proname in ('record_history', 'forbid_delete')`);
      expect(fns.rows).toEqual([]);
    });
  });

  it("document_versions is the only table with an append-only trigger (UPDATE/DELETE and TRUNCATE)", async () => {
    await withRollback(async (tx) => {
      const { rows } = await tx.execute<{ table: string; kind: string }>(sql`
        select c.relname as table, (case when (t.tgtype & 32) <> 0 then 'truncate' else 'row' end) as kind
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_proc p on p.oid = t.tgfoid
        where c.relnamespace = current_schema()::regnamespace and not t.tgisinternal
          and p.proname in ('forbid_mutation', 'forbid_delete', 'record_history')
        order by 1, 2`);
      expect(rows).toEqual([
        { table: "document_versions", kind: "row" },
        { table: "document_versions", kind: "truncate" },
      ]);
    });
  });

  it("updated_at moves on update of sources and documents", async () => {
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx);
      const documentId = await insertDocument(tx, sourceId);
      const [before] = await tx.select({ at: sources.updatedAt }).from(sources).where(eq(sources.id, sourceId));
      const [docBefore] = await tx.select({ at: documents.updatedAt }).from(documents).where(eq(documents.id, documentId));
      await tx.update(sources).set({ statusReason: "x" }).where(eq(sources.id, sourceId));
      await tx.update(documents).set({ etag: "e" }).where(eq(documents.id, documentId));
      const [after] = await tx.select({ at: sources.updatedAt }).from(sources).where(eq(sources.id, sourceId));
      const [docAfter] = await tx.select({ at: documents.updatedAt }).from(documents).where(eq(documents.id, documentId));
      expect(after!.at.getTime()).toBeGreaterThan(before!.at.getTime());
      expect(docAfter!.at.getTime()).toBeGreaterThan(docBefore!.at.getTime());
    });
  });

  it("(document_id, content_hash) is unique", async () => {
    await withRollback(async (tx) => {
      const documentId = await insertDocument(tx);
      await tx.insert(documentVersions).values(versionValues(documentId, { contentHash: "same" }));
      const message = await rejectionMessage(tx, (sp) =>
        sp.insert(documentVersions).values(versionValues(documentId, { contentHash: "same" })),
      );
      expect(message).toMatch(/document_versions_document_id_content_hash_unique/);
    });
  });

  it("only one valid source per domain", async () => {
    await withRollback(async (tx) => {
      const domain = testDomain();
      const first = await insertSource(tx, { domain });
      const message = await rejectionMessage(tx, (sp) => insertSource(sp, { domain }));
      expect(message).toMatch(/sources_domain_valid_unique/);

      await tx.update(sources).set({ validTo: "2026-10-19" }).where(eq(sources.id, first));
      await expect(insertSource(tx, { domain })).resolves.toBeTruthy();
    });
  });

  it("a source weight outside 0..1 is rejected", async () => {
    await withRollback(async (tx) => {
      const message = await rejectionMessage(tx, (sp) => insertSource(sp, { weight: 1.2 }));
      expect(message).toMatch(/sources_weight_range/);
    });
  });

  it("documents.current_version_id references document_versions", async () => {
    await withRollback(async (tx) => {
      const documentId = await insertDocument(tx);
      const [version] = await tx
        .insert(documentVersions)
        .values(versionValues(documentId))
        .returning({ id: documentVersions.id });
      await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, documentId));

      const message = await rejectionMessage(tx, (sp) =>
        sp.update(documents).set({ currentVersionId: newId() }).where(eq(documents.id, documentId)),
      );
      expect(message).toMatch(/foreign key/);
    });
  });

  it("restricted_areas.source_id references sources", async () => {
    await withRollback(async (tx) => {
      const geom = geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] });
      const sourceId = await insertSource(tx);
      await tx.insert(restrictedAreas).values({ kind: "military", geom, sourceId });

      const message = await rejectionMessage(tx, (sp) =>
        sp.insert(restrictedAreas).values({ kind: "military", geom, sourceId: newId() }),
      );
      expect(message).toMatch(/restricted_areas_source_id_sources_id_fk/);
    });
  });
});
