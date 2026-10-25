import { and, count, eq, gt, lte } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import type { ChangeEntry, HighlightsFile, RegionsFile, SpotsFile } from "@/contract/v3_0";
import type { Db } from "@/lib/db/client";
import { deliveries } from "@/lib/db/schema";
import { mergeChanges } from "../changes";
import { changesSince, resolveSubdivision } from "../read";
import { getRadiusPackage, radiusPackageByKey, readRadiusFile, type RadiusPackageRow } from "./build";

/*
 * Changes after the trip (spec 18, "Änderungen nach dem Törn"): the package `since` (from the cache) against the current
 * package for the same marina and days. The feed of every subdivision delivered in both packages between their two
 * versions, merged and limited to the objects of either package; an object only in the new package is `created`, one
 * only in the old `removed`, so the old package's objects plus `created` minus `removed` are the new package's objects.
 */

type ObjectType = ChangeEntry["objectType"];
type Objects = Map<string, { objectType: ObjectType; objectId: string; profileVersion: number }>;

const SUMMARY = { created: "Neu im Umkreis", removed: "Nicht mehr im Umkreis", updated: "Geändert." } as const;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const objectKey = (type: ObjectType, id: string) => `${type}:${id}`;

async function readJson<T>(archive: Archive, row: RadiusPackageRow, file: string): Promise<T> {
  const bytes = await readRadiusFile(archive, row, file);
  if (bytes === null) throw new Error(`radius package ${row.key} has no ${file}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** The spots, highlights and regions of a radius package with their profile versions, by `type:id`. */
async function packageObjects(archive: Archive, row: RadiusPackageRow): Promise<Objects> {
  const [spots, highlights, regions] = await Promise.all([
    readJson<SpotsFile>(archive, row, "spots.json"),
    readJson<HighlightsFile>(archive, row, "highlights.json"),
    readJson<RegionsFile>(archive, row, "regions.json"),
  ]);
  const out: Objects = new Map();
  const add = (objectType: ObjectType, list: Array<{ id: string; profileVersion: number }>) => {
    for (const o of list) out.set(objectKey(objectType, o.id), { objectType, objectId: o.id, profileVersion: o.profileVersion });
  };
  add("spot", spots.spots);
  add("highlight", highlights.highlights);
  add("region", regions.regions);
  return out;
}

/**
 * True when the subdivision's valid deliveries `from + 1 … to` are all there, so its feed from `from` to `to` can be
 * read (`changesSince` throws on a gap).
 */
async function feedComplete(db: Db, subdivisionId: string, from: number, to: number): Promise<boolean> {
  if (to < from) return false;
  const [row] = await db
    .select({ n: count() })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.subdivisionId, subdivisionId),
        eq(deliveries.status, "valid"),
        gt(deliveries.dataVersion, from),
        lte(deliveries.dataVersion, to),
      ),
    );
  return row!.n === to - from;
}

/**
 * The changes from the radius package `since` to the current package for `marina` and `days` (built if needed, one
 * `radius_package_requests` row of kind `changes`). `"invalid_since"` for an unknown key or the key of a package for
 * another marina or other days, and also when the feed of a subdivision delivered in both packages cannot be read from
 * the old version to the new one (the subdivision no longer valid, its version gone back, a version in between not
 * valid): the app then reloads the whole package. `since` equal to the current key gives no changes.
 *
 * Per subdivision delivered in both packages: its feed between the old and the new version (`changesSince`), the lists
 * merged with `mergeChanges` and kept for the objects of either package (spots, highlights, regions).
 *
 * An object in both packages is never `created` or `removed` (a spot that moved between two subdivisions is `removed`
 * in one feed and `created` in the other, or stays stale in its old subdivision until that one rebuilds, ruling
 * M6-P13): its feed entry is kept when it is `updated`, `excluded` or `merged`; otherwise, when its profile version
 * differs between the packages, an `updated` with no fields, `info` and „Geändert.“; else no entry.
 *
 * An object only in the new package is `created`, one only in the old
 * `removed`, whatever its feed entry says (a spot moved into or out of the circle by a correction has an `updated`
 * there, a subdivision missing before has none): a feed entry of that event is kept, any other replaced by „Neu im
 * Umkreis“ resp. „Nicht mehr im Umkreis“ with no fields, the feed entry's severity (`info` without one) and the
 * object's profile version in the new resp. old package. Sorted by object type, then id.
 */
export async function radiusChangesSince(
  db: Db,
  archive: Archive,
  req: { marina: string; days: number; since: string; apiClientId?: string },
): Promise<{ key: string; changes: ChangeEntry[] } | "marina_not_found" | "invalid_days" | "invalid_since"> {
  const current = await getRadiusPackage(db, archive, { marina: req.marina, days: req.days, apiClientId: req.apiClientId, kind: "changes" });
  if (typeof current === "string") return current;
  if (req.since === current.key) return { key: current.key, changes: [] };
  const old = await radiusPackageByKey(db, req.since);
  if (!old || old.homeMarinaPublicId !== req.marina || old.days !== req.days) return "invalid_since";

  const lists: ChangeEntry[][] = [];
  const oldVersions = new Map(old.coverage.filter((c) => c.status === "delivered").map((c) => [c.id, c.dataVersion!]));
  for (const entry of current.coverage) {
    const from = oldVersions.get(entry.id);
    if (entry.status !== "delivered" || from === undefined || from === entry.dataVersion) continue;
    const to = entry.dataVersion!;
    const subdivision = await resolveSubdivision(db, entry.id);
    if (!subdivision || !(await feedComplete(db, subdivision.id, from, to))) return "invalid_since";
    const feed = await changesSince(db, archive, subdivision.id, from);
    if (typeof feed === "string" || feed.dataVersion !== to) return "invalid_since";
    lists.push(feed.changes);
  }
  const merged = mergeChanges(lists);

  const [before, after] = await Promise.all([packageObjects(archive, old), packageObjects(archive, current)]);
  const feed = new Map(merged.map((e) => [objectKey(e.objectType, e.objectId), e]));
  const changes: ChangeEntry[] = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (a === undefined) continue;
    const e = feed.get(key);
    if (e !== undefined && e.event !== "created" && e.event !== "removed") {
      changes.push(e);
    } else if (a.profileVersion !== b.profileVersion) {
      changes.push({
        objectType: a.objectType,
        objectId: a.objectId,
        event: "updated",
        fields: [],
        severity: "info",
        summary: { de: SUMMARY.updated },
        profileVersion: a.profileVersion,
      });
    }
  }
  const boundary = (objects: Objects, others: Objects, event: "created" | "removed") => {
    for (const [key, o] of objects) {
      if (others.has(key)) continue;
      const e = feed.get(key);
      if (e?.event === event) {
        changes.push(e);
        continue;
      }
      changes.push({
        objectType: o.objectType,
        objectId: o.objectId,
        event,
        fields: [],
        severity: e?.severity ?? "info",
        summary: { de: SUMMARY[event] },
        profileVersion: o.profileVersion,
      });
    }
  };
  boundary(after, before, "created");
  boundary(before, after, "removed");
  changes.sort((a, b) => cmp(a.objectType, b.objectType) || cmp(a.objectId, b.objectId));
  return { key: current.key, changes };
}
