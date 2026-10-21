import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { loadAreaFiles, type AreaFile, type ImportedArea } from "./file";
import { computeAreaPolygon } from "./polygon";
import { resolveAreaMembers, scopeSubdivisionIds, type MemberEntry } from "./resolve";
import {
  addAreaEvidence,
  createArea,
  endMissingAreas,
  findArea,
  linkTiles,
  reviveArea,
  syncAreaMembers,
  syncAreaNames,
  updateArea,
} from "./store";

/*
 * Import of a Revier-Bot delivery (spec 14, „Änderung 21.10.2026“). The bot is the source of truth: per file area
 * one geo object `area` (`config_key` = bot key), names of origin `import`, evidence, resolved members and the
 * computed polygon; an area missing from the file ends. Idempotent: a second import of the same file writes no row.
 */

export type AreaImportReport = {
  country: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  ended: string[];
  /** Areas with fewer than `minMembers` resolved members and no area yet („wartet auf Gazetteer“). */
  waiting: Array<{ key: string; resolved: number; unresolved: string[] }>;
  /** Subdivision keys of the file that name no valid subdivision; the area imports from its other keys. */
  unknownSubdivisions: Array<{ key: string; subdivision: string }>;
  /**
   * Keys whose valid area (by key or by alias) another country's file imported (`tags.importCountry`): the area is
   * neither taken over nor changed; the key is skipped until one of both files gives it up.
   */
  conflicts: Array<{ key: string; otherCountry: string }>;
};

function entriesOf(area: ImportedArea): MemberEntry[] {
  return [
    ...area.members.map((m) => ({ name: m.name, type: m.type, role: "member" as const })),
    ...area.boundaryPoints.map((m) => ({ name: m.name, type: m.type, role: "boundary" as const })),
  ];
}

/**
 * Imports one file inside the caller's transaction. Per area: the valid area by `config_key = key`, else by a legacy
 * key whose alias is `key` (its `config_key` becomes `key`, id and public id stay), else an ended area of the key, which
 * is revived when a polygon exists (a valid area another country's file imported is a conflict and skipped); members resolved in the file's subdivisions; the polygon. Without polygon and
 * without an area the area waits; without polygon but with an area its geometry and members stay and the rest is
 * updated. A revived area counts as `updated`. Areas of `file.country` not in the file end on `today`.
 */
export async function importAreaFile(db: Db, file: AreaFile, cfg: AppConfig, today: string): Promise<AreaImportReport> {
  const report: AreaImportReport = {
    country: file.country,
    created: [],
    updated: [],
    unchanged: [],
    ended: [],
    waiting: [],
    unknownSubdivisions: [],
    conflicts: [],
  };
  for (const area of file.areas) {
    const found = await findArea(db, area.key, cfg.areas.aliases, file.country);
    const otherCountry = found && !found.ended ? found.tags.importCountry : undefined;
    // A pilot area (no importCountry) may be taken over; an area of another country's file may not.
    if (typeof otherCountry === "string" && otherCountry !== file.country) {
      report.conflicts.push({ key: area.key, otherCountry });
      continue;
    }
    const scope = await scopeSubdivisionIds(db, area.subdivisions, cfg);
    for (const subdivision of scope.unknown) report.unknownSubdivisions.push({ key: area.key, subdivision });
    const { resolved, unresolved } = await resolveAreaMembers(db, entriesOf(area), scope.ids, cfg);
    const polygon = await computeAreaPolygon(db, resolved.map((r) => r.geoObjectId), cfg);
    // An ended area comes back only with a polygon; until then the key waits like a new one.
    const existing = found && (!found.ended || polygon) ? found : null;
    if (!polygon && !existing) {
      report.waiting.push({ key: area.key, resolved: resolved.length, unresolved: unresolved.map((u) => u.name) });
      continue;
    }
    const tags = {
      ...(existing?.tags ?? {}),
      boundary: area.boundary,
      related: area.related,
      notes: area.notes,
      unresolvedMembers: unresolved,
      polygonOrigin: polygon?.origin ?? existing?.tags.polygonOrigin ?? null,
      importCountry: file.country,
    };
    let id: string;
    let changed: boolean;
    if (!existing) {
      id = await createArea(db, area.key, polygon!.geom, tags);
      changed = true;
    } else {
      id = existing.id;
      if (existing.ended) await reviveArea(db, id);
      changed = await updateArea(db, existing, area.key, polygon?.geom ?? null, tags);
      if (existing.ended) {
        await linkTiles(db, id);
        changed = true;
      }
    }
    if ((await syncAreaNames(db, id, area.names, today)) > 0) changed = true;
    if ((await addAreaEvidence(db, id, area.evidence, file.generatedAt)) > 0) changed = true;
    // Without a polygon the area keeps its stored one, and so its members: they stay the members of that polygon.
    if (polygon && (await syncAreaMembers(db, id, resolved))) changed = true;
    if (!existing) report.created.push(area.key);
    else (changed ? report.updated : report.unchanged).push(area.key);
  }
  report.ended = await endMissingAreas(db, file.country, file.areas.map((a) => a.key), today);
  return report;
}

/** Imports every file of `dir` (`loadAreaFiles`), one transaction per file. */
export async function importAllAreaFiles(
  db: Db,
  cfg: AppConfig,
  today: string,
  dir?: string,
): Promise<AreaImportReport[]> {
  const files = await loadAreaFiles(dir);
  const reports: AreaImportReport[] = [];
  for (const file of files) reports.push(await db.transaction((tx) => importAreaFile(tx, file, cfg, today)));
  return reports;
}
