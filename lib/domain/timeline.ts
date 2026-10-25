import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";

// Task 4: remove with `profiles`; `lib/domain/delivery/**` still imports `validAt`/`validAtAlias` from here.
export { validAt, validAtAlias } from "@/lib/db/valid-at";

const snapshotColumns = {
  version: profiles.version,
  validFrom: profiles.validFrom,
  attributes: profiles.attributes,
  provenance: profiles.provenance,
  conflicts: profiles.conflicts,
  gaps: profiles.gaps,
  sourcesCount: profiles.sourcesCount,
  documentsCount: profiles.documentsCount,
  confidence: profiles.confidence,
  contentHash: profiles.contentHash,
  rulesVersion: profiles.rulesVersion,
  factSchemaVersion: profiles.factSchemaVersion,
};

/**
 * The profile of the geo object as of `date` (ISO `YYYY-MM-DD`): the version with the largest `valid_from <= date`,
 * on the same date the highest version; null before the first version. The only place of this rule (spec 07
 * `profile_as_of`).
 */
export async function profileAsOf(db: Db, geoObjectId: string, date: string): Promise<ProfileSnapshot | null> {
  const [row] = await db
    .select(snapshotColumns)
    .from(profiles)
    .where(and(eq(profiles.geoObjectId, geoObjectId), lte(profiles.validFrom, date)))
    .orderBy(desc(profiles.validFrom), desc(profiles.version))
    .limit(1);
  return row ?? null;
}

/** The newest profile version of the geo object (highest `version`), or null without one. */
export async function latestProfile(db: Db, geoObjectId: string): Promise<ProfileSnapshot | null> {
  const [row] = await db
    .select(snapshotColumns)
    .from(profiles)
    .where(eq(profiles.geoObjectId, geoObjectId))
    .orderBy(desc(profiles.version))
    .limit(1);
  return row ?? null;
}

/** The newest profile version of each of the geo objects (as `latestProfile`), by geo object id; none → no entry. */
export async function latestProfiles(db: Db, geoObjectIds: string[]): Promise<Map<string, ProfileSnapshot>> {
  if (geoObjectIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([profiles.geoObjectId], { geoObjectId: profiles.geoObjectId, ...snapshotColumns })
    .from(profiles)
    .where(inArray(profiles.geoObjectId, geoObjectIds))
    .orderBy(profiles.geoObjectId, desc(profiles.version));
  return new Map(rows.map(({ geoObjectId, ...snapshot }) => [geoObjectId, snapshot]));
}

/** Version `version` of the geo object's profile, or null when it has no such version. */
export async function profileVersion(db: Db, geoObjectId: string, version: number): Promise<ProfileSnapshot | null> {
  const [row] = await db
    .select(snapshotColumns)
    .from(profiles)
    .where(and(eq(profiles.geoObjectId, geoObjectId), eq(profiles.version, version)))
    .limit(1);
  return row ?? null;
}
