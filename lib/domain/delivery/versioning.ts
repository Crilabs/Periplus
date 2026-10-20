import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { HighlightBody, RegionBody, SpotBody } from "@/contract";
import type { Db } from "@/lib/db/client";
import type { DeliveredObjectType } from "@/lib/db/schema/deliveries";
import { canonicalJson } from "@/lib/domain/facts/schema";

/*
 * Contract versions (spec 08 "profileVersion im Vertrag = Version des Vertragsobjekts … steigt nur, wenn sich das
 * gelieferte Objekt ändert"): a version is keyed by the hash of the serialized contract object without its version
 * fields. Spot and highlight versions count per public id across subdivisions, region versions per subdivision (ruling M6-P13).
 */

/** A contract object of the next package before it gets its version. */
export type ObjectDraft = {
  type: DeliveredObjectType;
  id: string;
  geoObjectId: string | null;
  body: SpotBody | HighlightBody | RegionBody;
};

/**
 * The subdivision's latest delivered version of an object. `maxVersion`: the highest version of the public id anywhere
 * (spot and highlight versions are global, ruling M6-P13), the base of the next one; equal to `profileVersion` unless
 * the object was also delivered by another subdivision (or by a pilot package of contract 1.0).
 */
export type LatestDelivered = {
  profileVersion: number;
  contentHash: string;
  validFrom: string;
  removed: boolean;
  maxVersion?: number;
};

export type DeliveredEntry = LatestDelivered & { type: DeliveredObjectType; geoObjectId: string | null };

export type VersionedObject = ObjectDraft & {
  profileVersion: number;
  validFrom: string;
  contentHash: string;
  status: "created" | "updated" | "same";
};

export type RemovedObject = { type: DeliveredObjectType; id: string; geoObjectId: string | null; profileVersion: number };

/**
 * A contract value with every object key whose value is `null` or absent dropped (recursively, array elements kept):
 * the contract does not tell `null` from an absent field, so neither may the hash or the diff.
 */
export function withoutNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutNulls);
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null && x !== undefined)
        .map(([k, x]) => [k, withoutNulls(x)]),
    );
  }
  return v;
}

/**
 * sha256 hex of the canonical JSON of a contract body (the version fields are never part of it), `null` and absent
 * fields alike.
 */
export function contentHash(body: object): string {
  return createHash("sha256").update(canonicalJson(withoutNulls(body)), "utf8").digest("hex");
}

type LatestRow = {
  public_id: string;
  object_type: DeliveredObjectType;
  geo_object_id: string | null;
  profile_version: number;
  content_hash: string;
  valid_from: string;
  removed: boolean;
  own: boolean;
  max_version: number;
};

/**
 * Per public id, the subdivision's latest delivered row (highest `profile_version`), with `maxVersion` over every
 * package for spots and highlights. A spot or highlight delivered only by other subdivisions is part of the map as
 * `removed` (it is not in this subdivision's package) carrying its global version, so delivering it here continues
 * the version instead of restarting at 1 (a place that changed its subdivision, ruling M6-P13).
 */
export async function latestDelivered(db: Db, subdivisionId: string): Promise<Map<string, DeliveredEntry>> {
  const { rows } = await db.execute<LatestRow>(sql`
    with candidates as (
      select d.*, coalesce(d.subdivision_id = ${subdivisionId}::uuid, false) as own, max(d.profile_version) over (partition by d.public_id) as max_version
      from delivered_objects d
      where d.subdivision_id = ${subdivisionId}::uuid or d.object_type in ('spot', 'highlight')
    )
    select distinct on (public_id) public_id, object_type, geo_object_id, profile_version, content_hash,
           valid_from::text as valid_from, removed, own, max_version
    from candidates
    order by public_id, own desc, profile_version desc
  `);
  const out = new Map<string, DeliveredEntry>();
  for (const r of rows) {
    const maxVersion = Number(r.max_version);
    out.set(r.public_id, {
      type: r.object_type,
      geoObjectId: r.geo_object_id,
      profileVersion: r.own ? Number(r.profile_version) : maxVersion,
      contentHash: r.own ? r.content_hash : "removed",
      validFrom: r.valid_from,
      removed: r.own ? r.removed : true,
      maxVersion,
    });
  }
  return out;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const nextVersion = (l: LatestDelivered) => Math.max(l.maxVersion ?? l.profileVersion, l.profileVersion) + 1;

/**
 * Versions of the next package: an object without an entry or with a `removed` one is `created` (the version after the
 * last one, else 1); the same hash keeps version and `validFrom` (`same`); another hash is `updated` with the next
 * version from `today`. `removed`: the subdivision's delivered objects missing from the drafts, with their next version.
 */
export function assignVersions(
  drafts: ObjectDraft[],
  latest: Map<string, LatestDelivered & { type: DeliveredObjectType; geoObjectId: string | null }>,
  today: string,
): { objects: VersionedObject[]; removed: RemovedObject[] } {
  const ids = new Set<string>();
  const objects = drafts.map((d): VersionedObject => {
    if (ids.has(d.id)) throw new Error(`duplicate draft ${d.id}`);
    ids.add(d.id);
    const hash = contentHash(d.body);
    const l = latest.get(d.id);
    if (!l || l.removed) {
      return { ...d, profileVersion: l ? nextVersion(l) : 1, validFrom: today, contentHash: hash, status: "created" };
    }
    if (l.contentHash === hash) {
      return { ...d, profileVersion: l.profileVersion, validFrom: l.validFrom, contentHash: hash, status: "same" };
    }
    return { ...d, profileVersion: nextVersion(l), validFrom: today, contentHash: hash, status: "updated" };
  });
  const removed = [...latest.entries()]
    .filter(([id, l]) => !l.removed && !ids.has(id))
    .map(([id, l]): RemovedObject => ({ type: l.type, id, geoObjectId: l.geoObjectId, profileVersion: nextVersion(l) }))
    .sort(byId);
  return { objects, removed };
}
