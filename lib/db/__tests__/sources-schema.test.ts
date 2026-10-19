import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { chunks, documents, documentVersions, restrictedAreas, sources } from "@/lib/db/schema";
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

async function insertChunk(tx: Db): Promise<string> {
  const documentVersionId = await insertVersion(tx);
  const [row] = await tx
    .insert(chunks)
    .values({
      documentVersionId,
      ordinal: 0,
      text: "Good holding in sand.",
      textNormalized: "good holding in sand",
      textHash: "t1",
      charStart: 0,
      charEnd: 21,
      wordCount: 4,
    })
    .returning({ id: chunks.id });
  return row!.id;
}

const embedding = () => Array.from({ length: 1024 }, (_, i) => (i % 7) / 7);

describe("archive schema", () => {
  it.each([
    ["document_versions", insertVersion],
    ["chunks", insertChunk],
  ] as const)("%s rejects DELETE", async (table, insert) => {
    await withRollback(async (tx) => {
      const id = await insert(tx);
      const message = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`),
      );
      expect(message).toMatch(new RegExp(`${table} is append-only`));
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

  it("chunks allow setting the embedding but not changing the text", async () => {
    await withRollback(async (tx) => {
      const id = await insertChunk(tx);
      await tx.update(chunks).set({ embedding: embedding(), embeddingModel: "voyage-3.5" }).where(eq(chunks.id, id));
      const [row] = await tx.select({ model: chunks.embeddingModel }).from(chunks).where(eq(chunks.id, id));
      expect(row!.model).toBe("voyage-3.5");

      const message = await rejectionMessage(tx, (sp) =>
        sp.update(chunks).set({ text: "Changed." }).where(eq(chunks.id, id)),
      );
      expect(message).toMatch(/chunks is append-only/);
    });
  });

  it.each([
    ["sources", insertSource],
    ["documents", insertDocument],
  ] as const)("%s cannot be deleted", async (table, insert) => {
    await withRollback(async (tx) => {
      const id = await insert(tx);
      const message = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`),
      );
      expect(message).toMatch(new RegExp(`${table} rows are never deleted`));
    });
  });

  it("changing a source's weight writes sources_history", async () => {
    await withRollback(async (tx) => {
      const id = await insertSource(tx, { weight: 0.5 });
      await tx.update(sources).set({ name: "Renamed" }).where(eq(sources.id, id));
      await tx.update(sources).set({ weight: 0.7 }).where(eq(sources.id, id));

      const rows = await tx.execute<{ weight: number }>(
        sql`select (old_row ->> 'weight')::real as weight from sources_history where row_id = ${id}`,
      );
      expect(rows.rows).toEqual([{ weight: 0.5 }]);
    });
  });

  it("changing a document's status writes documents_history", async () => {
    await withRollback(async (tx) => {
      const id = await insertDocument(tx);
      await tx.update(documents).set({ consecutiveGone: 1 }).where(eq(documents.id, id));
      await tx.update(documents).set({ status: "gone" }).where(eq(documents.id, id));

      const rows = await tx.execute<{ status: string }>(
        sql`select old_row ->> 'status' as status from documents_history where row_id = ${id}`,
      );
      expect(rows.rows).toEqual([{ status: "active" }]);
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

  it("chunks.embedding is vector(1024) with an hnsw index", async () => {
    await withRollback(async (tx) => {
      const type = await tx.execute<{ type: string }>(sql`
        select format_type(atttypid, atttypmod) as type from pg_attribute
        where attrelid = 'chunks'::regclass and attname = 'embedding'`);
      expect(type.rows[0]?.type).toBe("vector(1024)");

      const index = await tx.execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes where tablename = 'chunks' and indexname = 'chunks_embedding_hnsw'`);
      expect(index.rows[0]?.indexdef).toMatch(/hnsw.*vector_cosine_ops/);

      const trgm = await tx.execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes where tablename = 'chunks' and indexdef like '%gin_trgm_ops%'`);
      expect(trgm.rows[0]?.indexdef).toMatch(/text_normalized gin_trgm_ops/);
    });
  });
});
