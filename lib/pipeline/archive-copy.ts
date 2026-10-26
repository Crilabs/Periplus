import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { count, getTableColumns, gt, inArray, and, eq, isNull, asc, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, serpQueries, serpResults, sources } from "@/lib/db/schema";

/*
 * Copies the fetched-page archive (sources, documents, document versions with their S3 objects, search cache) from one
 * environment to another through a directory: `exportArchive` writes JSONL per table plus `objects/<key>` and a
 * manifest with SHA-256 per object, `importArchive` reads it back. Never deletes anything; import only inserts
 * (ON CONFLICT DO NOTHING), so it is idempotent and leaves append-only tables unchanged.
 */

export const BATCH_SIZE = 1000;
export const MANIFEST_FILE = "manifest.json";

export type ArchiveTable = "sources" | "documents" | "document_versions" | "serp_queries" | "serp_results";
type Column = AnyPgColumn;
type TableSpec = {
  name: string;
  table: PgTable & { id: Column };
  /** NOT NULL foreign keys that must point at a row of the archive (or the target): otherwise the row is skipped. */
  parents: { key: string; parent: ArchiveTable }[];
  /** Nullable foreign keys to tables outside the archive (runs): set to null on import. */
  nullify: string[];
};

const SPECS: Record<ArchiveTable, TableSpec> = {
  sources: { name: "sources", table: sources, parents: [], nullify: [] },
  documents: {
    name: "documents",
    table: documents,
    parents: [{ key: "sourceId", parent: "sources" }],
    // current_version_id points at a version inserted later and is linked afterwards.
    nullify: ["currentVersionId"],
  },
  document_versions: {
    name: "document_versions",
    table: documentVersions,
    parents: [{ key: "documentId", parent: "documents" }],
    nullify: ["runId", "classifiedRunId"],
  },
  serp_queries: { name: "serp_queries", table: serpQueries, parents: [], nullify: ["runId"] },
  serp_results: {
    name: "serp_results",
    table: serpResults,
    parents: [{ key: "serpQueryId", parent: "serp_queries" }],
    nullify: [],
  },
};

export const ARCHIVE_TABLES = Object.keys(SPECS) as ArchiveTable[];

export type ManifestObject = { sha256: string; size: number; contentType: string };
export type Manifest = {
  format: 1;
  createdAt: string;
  counts: Record<ArchiveTable, number>;
  /** Rows left out of the export because an object they reference is missing in S3. */
  skipped: { document_versions: number; serp_queries: number; serp_results: number };
  objects: Record<string, ManifestObject>;
};

type Row = Record<string, unknown>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectPath(dir: string, key: string): string {
  const root = path.resolve(dir, "objects");
  const full = path.resolve(root, key);
  if (key === "" || key.startsWith("/") || !full.startsWith(root + path.sep)) throw new Error(`unsafe object key: ${key}`);
  return full;
}

function contentTypeFor(key: string, fallback: string | null): string {
  if (fallback) return fallback;
  if (key.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function* batches(db: Db, spec: TableSpec): AsyncGenerator<Row[]> {
  let last: string | undefined;
  for (;;) {
    const where: SQL | undefined = last === undefined ? undefined : gt(spec.table.id, last);
    const rows = (await db.select().from(spec.table).where(where).orderBy(asc(spec.table.id)).limit(BATCH_SIZE)) as Row[];
    if (rows.length === 0) return;
    yield rows;
    last = rows[rows.length - 1]!.id as string;
    if (rows.length < BATCH_SIZE) return;
  }
}

async function writeLines(file: string, lines: string[]): Promise<void> {
  const stream = createWriteStream(file, { flags: "a" });
  for (const l of lines) if (!stream.write(l + "\n")) await once(stream, "drain");
  stream.end();
  await once(stream, "finish");
}

/** Object keys a row references, with the content type to store them under. */
function versionObjects(v: Row): { key: string; contentType: string }[] {
  const out = [
    { key: v.rawKey as string, contentType: contentTypeFor(v.rawKey as string, (v.contentType as string | null) ?? null) },
    { key: v.mdKey as string, contentType: contentTypeFor(v.mdKey as string, "text/markdown; charset=utf-8") },
  ];
  if (v.diffKey) out.push({ key: v.diffKey as string, contentType: contentTypeFor(v.diffKey as string, null) });
  return out;
}

export async function exportArchive(deps: { db: Db; archive: Archive; dir: string; log?: (line: string) => void }): Promise<Manifest> {
  const { db, archive, dir } = deps;
  const log = deps.log ?? (() => {});
  await mkdir(path.join(dir, "objects"), { recursive: true });
  const manifest: Manifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    counts: { sources: 0, documents: 0, document_versions: 0, serp_queries: 0, serp_results: 0 },
    skipped: { document_versions: 0, serp_queries: 0, serp_results: 0 },
    objects: {},
  };
  const missing = new Set<string>();

  /** Fetches the object into the directory; false when S3 does not have it. */
  async function takeObject(key: string, contentType: string): Promise<boolean> {
    if (manifest.objects[key]) return true;
    if (missing.has(key)) return false;
    const bytes = await archive.get(key);
    if (!bytes) {
      missing.add(key);
      return false;
    }
    const file = objectPath(dir, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    manifest.objects[key] = { sha256: sha256(bytes), size: bytes.length, contentType };
    return true;
  }

  const exportedQueries = new Set<string>();
  for (const name of ARCHIVE_TABLES) {
    const spec = SPECS[name];
    const file = path.join(dir, `${name}.jsonl`);
    await writeFile(file, "");
    for await (const rows of batches(db, spec)) {
      const lines: string[] = [];
      for (const row of rows) {
        if (name === "document_versions") {
          let ok = true;
          for (const o of versionObjects(row)) ok = (await takeObject(o.key, o.contentType)) && ok;
          if (!ok) {
            manifest.skipped.document_versions++;
            continue;
          }
        } else if (name === "serp_queries") {
          if (!(await takeObject(row.rawKey as string, "application/json"))) {
            manifest.skipped.serp_queries++;
            continue;
          }
          exportedQueries.add(row.id as string);
        } else if (name === "serp_results" && !exportedQueries.has(row.serpQueryId as string)) {
          manifest.skipped.serp_results++;
          continue;
        }
        lines.push(JSON.stringify(row));
      }
      await writeLines(file, lines);
      manifest.counts[name] += lines.length;
    }
    log(`export ${name}: ${manifest.counts[name]} rows`);
  }
  await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
  log(`export objects: ${Object.keys(manifest.objects).length}`);
  return manifest;
}

export type TableReport = {
  before: number;
  after: number;
  read: number;
  /** Rows inserted (dry run: rows that would be inserted). */
  inserted: number;
  /** Rows already present in the target (same id or same unique key). */
  existing: number;
  /** Rows left out: a NOT NULL foreign key points outside the archive and the target. */
  skippedNoParent: number;
  /** Rows whose id is not in the target after the insert: another unique key (domain, URL, content hash) held a different row. */
  skippedConflict: number;
  /** Document versions left out because an object is missing, corrupt or unreadable. */
  skippedObjectError: number;
};
export type ImportReport = {
  dryRun: boolean;
  tables: Record<ArchiveTable, TableReport>;
  /** Objects that failed verification (missing, size or SHA-256 mismatch, unreadable). */
  objectErrors: { key: string; reason: string }[];
  objectsUploaded: number;
  objectsPresent: number;
  /** Documents of this import whose current version was linked after the versions went in. */
  currentVersionsLinked: number;
};

async function countRows(db: Db, spec: TableSpec): Promise<number> {
  const [r] = await db.select({ n: count() }).from(spec.table);
  return r?.n ?? 0;
}

async function* readLines(file: string): AsyncGenerator<Row[]> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let batch: Row[] = [];
  for await (const line of rl) {
    if (line.trim() === "") continue;
    batch.push(JSON.parse(line) as Row);
    if (batch.length === BATCH_SIZE) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/** JSON has no timestamps: turn the ISO strings of `timestamp` columns back into dates. */
function revive(spec: TableSpec, row: Row): Row {
  const out: Row = { ...row };
  for (const [key, col] of Object.entries(getTableColumns(spec.table))) {
    if (col.dataType === "date" && typeof out[key] === "string") out[key] = new Date(out[key] as string);
  }
  for (const key of spec.nullify) out[key] = null;
  return out;
}

export async function importArchive(deps: {
  db: Db;
  archive: Archive;
  dir: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<ImportReport> {
  const { db, archive, dir } = deps;
  const dryRun = deps.dryRun ?? false;
  const log = deps.log ?? (() => {});
  const manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8")) as Manifest;
  if (manifest.format !== 1) throw new Error(`unknown manifest format ${String(manifest.format)}`);

  const empty = (): TableReport => ({ before: 0, after: 0, read: 0, inserted: 0, existing: 0, skippedNoParent: 0, skippedConflict: 0, skippedObjectError: 0 });
  const report: ImportReport = {
    dryRun,
    tables: { sources: empty(), documents: empty(), document_versions: empty(), serp_queries: empty(), serp_results: empty() },
    objectErrors: [],
    objectsUploaded: 0,
    objectsPresent: 0,
    currentVersionsLinked: 0,
  };
  for (const name of ARCHIVE_TABLES) report.tables[name].before = await countRows(db, SPECS[name]);

  // Ids that exist in the target or will after this run (in a dry run: would).
  const known: Record<ArchiveTable, Set<string>> = {
    sources: new Set(),
    documents: new Set(),
    document_versions: new Set(),
    serp_queries: new Set(),
    serp_results: new Set(),
  };
  const objectOk = new Map<string, boolean>();

  async function parentsExist(parent: ArchiveTable, ids: string[]): Promise<void> {
    const unknown = [...new Set(ids)].filter((id) => !known[parent].has(id));
    for (let i = 0; i < unknown.length; i += BATCH_SIZE) {
      const chunk = unknown.slice(i, i + BATCH_SIZE);
      const found = await db.select({ id: SPECS[parent].table.id }).from(SPECS[parent].table).where(inArray(SPECS[parent].table.id, chunk));
      for (const f of found) known[parent].add(f.id as string);
    }
  }

  async function verifyObject(key: string): Promise<boolean> {
    const cached = objectOk.get(key);
    if (cached !== undefined) return cached;
    const fail = (reason: string) => {
      report.objectErrors.push({ key, reason });
      objectOk.set(key, false);
      return false;
    };
    const entry = manifest.objects[key];
    if (!entry) return fail("not in manifest");
    let bytes: Buffer;
    try {
      bytes = await readFile(objectPath(dir, key));
    } catch (err) {
      return fail(`unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (bytes.length !== entry.size) return fail(`size ${bytes.length}, manifest ${entry.size}`);
    if (sha256(bytes) !== entry.sha256) return fail("SHA-256 mismatch");
    const present = await archive.exists(key);
    if (present) {
      // Never overwrite: an existing object must carry exactly the archived bytes, else the version would point at foreign content.
      const theirs = await archive.get(key);
      if (theirs && (theirs.length !== entry.size || sha256(theirs) !== entry.sha256)) return fail("target object exists with different content");
    }
    if (present) report.objectsPresent++;
    else {
      if (!dryRun) await archive.put(key, bytes, entry.contentType);
      report.objectsUploaded++;
    }
    objectOk.set(key, true);
    return true;
  }

  /** Archive document id -> its current version id (linked after the versions, also on a rerun). */
  const archiveCurrent = new Map<string, string>();

  for (const name of ARCHIVE_TABLES) {
    const spec = SPECS[name];
    const rep = report.tables[name];
    const file = path.join(dir, `${name}.jsonl`);
    for await (const rows of readLines(file)) {
      rep.read += rows.length;
      for (const p of spec.parents) await parentsExist(p.parent, rows.map((r) => r[p.key] as string));
      const valid: Row[] = [];
      for (const row of rows) {
        if (spec.parents.some((p) => !known[p.parent].has(row[p.key] as string))) {
          rep.skippedNoParent++;
          continue;
        }
        if (name === "document_versions") {
          let ok = true;
          for (const o of versionObjects(row)) ok = (await verifyObject(o.key)) && ok;
          if (!ok) {
            rep.skippedObjectError++;
            continue;
          }
        } else if (name === "serp_queries" && !(await verifyObject(row.rawKey as string))) {
          rep.skippedObjectError++;
          continue;
        }
        if (name === "documents" && row.currentVersionId) archiveCurrent.set(row.id as string, row.currentVersionId as string);
        valid.push(row);
      }
      if (valid.length === 0) continue;
      const ids = valid.map((r) => r.id as string);
      let inserted: string[];
      let presentIds: Set<string>;
      if (dryRun) {
        const there = new Set(
          (await db.select({ id: spec.table.id }).from(spec.table).where(inArray(spec.table.id, ids))).map((r) => r.id as string),
        );
        inserted = ids.filter((id) => !there.has(id));
        presentIds = new Set(ids);
      } else {
        const res = await db
          .insert(spec.table)
          .values(valid.map((r) => revive(spec, r)) as never)
          .onConflictDoNothing()
          .returning({ id: spec.table.id });
        inserted = res.map((r) => r.id as string);
        // A row counts as present by its id, not by the conflict count: another unique key may have swallowed it.
        presentIds = new Set(
          (await db.select({ id: spec.table.id }).from(spec.table).where(inArray(spec.table.id, ids))).map((r) => r.id as string),
        );
      }
      rep.inserted += inserted.length;
      rep.existing += presentIds.size - inserted.length;
      rep.skippedConflict += ids.length - presentIds.size;
      for (const id of presentIds) known[name].add(id);
      if (name === "documents") for (const id of ids) if (!presentIds.has(id)) archiveCurrent.delete(id);
    }
    if (rep.read !== manifest.counts[name]) {
      throw new Error(`${name}.jsonl has ${rep.read} rows, manifest says ${manifest.counts[name]} (incomplete transfer?)`);
    }
    log(`import ${name}: read ${rep.read}, inserted ${rep.inserted}`);
  }

  // Documents of the archive whose current version is still unset in the target get it now that the versions exist
  // (an update of the document, never of a version; the IS NULL guard never overwrites a link). Covers reruns.
  const pairs = [...archiveCurrent.entries()];
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const chunk = pairs.slice(i, i + BATCH_SIZE);
    const docRows = await db
      .select({ id: documents.id, cv: documents.currentVersionId })
      .from(documents)
      .where(inArray(documents.id, chunk.map(([d]) => d)));
    const docState = new Map(docRows.map((r) => [r.id, r.cv]));
    const versionRows = await db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(inArray(documentVersions.id, chunk.map(([, v]) => v)));
    const versionThere = new Set(versionRows.map((r) => r.id));
    for (const [docId, versionId] of chunk) {
      const inTarget = docState.has(docId);
      const unset = !inTarget || docState.get(docId) === null;
      const versionOk = versionThere.has(versionId) || (dryRun && known.document_versions.has(versionId));
      if (!unset || !versionOk) continue;
      if (dryRun) {
        report.currentVersionsLinked++;
        continue;
      }
      const res = await db
        .update(documents)
        .set({ currentVersionId: versionId })
        .where(and(eq(documents.id, docId), isNull(documents.currentVersionId)))
        .returning({ id: documents.id });
      report.currentVersionsLinked += res.length;
    }
  }

  for (const name of ARCHIVE_TABLES) report.tables[name].after = await countRows(db, SPECS[name]);
  return report;
}

export function formatReport(report: ImportReport): string {
  const lines = [report.dryRun ? "DRY RUN: nothing was written" : "import done", "table\tbefore\tafter\tread\tinserted\texisting\tskipped (no parent)\tskipped (conflict)\tskipped (object)"];
  for (const name of ARCHIVE_TABLES) {
    const t = report.tables[name];
    lines.push(`${name}\t${t.before}\t${t.after}\t${t.read}\t${t.inserted}\t${t.existing}\t${t.skippedNoParent}\t${t.skippedConflict}\t${t.skippedObjectError}`);
  }
  lines.push(`objects: ${report.objectsUploaded} ${report.dryRun ? "to upload" : "uploaded"}, ${report.objectsPresent} already present, ${report.objectErrors.length} errors`);
  for (const e of report.objectErrors) lines.push(`ERROR object ${e.key}: ${e.reason}`);
  lines.push(`current versions linked: ${report.currentVersionsLinked}`);
  return lines.join("\n");
}
