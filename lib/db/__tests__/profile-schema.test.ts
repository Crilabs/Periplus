import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { visibleChangeEventsFilter } from "@/lib/domain/change-feed";
import { changeEvents, geoObjects, profileSummaries, profiles } from "@/lib/db/schema";
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

// Synthetic data outside the pilot box (23.0-23.75 E x 37.0-38.0 N).
async function insertGeoObject(tx: Db): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({ type: "bay", origin: "osm", geom: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
    .returning({ id: geoObjects.id });
  return row!.id;
}

const profileValues = (geoObjectId: string, version: number, validFrom = "2026-10-19") => ({
  geoObjectId,
  version,
  validFrom,
  attributes: { "shelter.N": 0.8 },
  provenance: {},
  sourcesCount: 1,
  documentsCount: 1,
  confidence: 0.6,
  contentHash: `h${version}`,
  factSchemaVersion: "v2",
  rulesVersion: "v1",
});

async function insertRow(tx: Db, table: string, geoObjectId: string): Promise<string> {
  if (table === "profiles") {
    const [row] = await tx.insert(profiles).values(profileValues(geoObjectId, 1)).returning({ id: profiles.id });
    return row!.id;
  }
  if (table === "change_events") {
    const [row] = await tx
      .insert(changeEvents)
      .values({ geoObjectId, profileVersion: 1, type: "new_attribute", attribute: "shelter.N", newValue: 0.8, severity: "info" })
      .returning({ id: changeEvents.id });
    return row!.id;
  }
  const [row] = await tx
    .insert(profileSummaries)
    .values({ geoObjectId, profileVersion: 1, text: "Eine Bucht.", status: "ok", attempts: 1, model: "m", promptVersion: 1 })
    .returning({ id: profileSummaries.id });
  return row!.id;
}

describe("profiles, change events and summaries", () => {
  it.each(["profiles", "change_events", "profile_summaries"])("%s rejects UPDATE and DELETE", async (table) => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const id = await insertRow(tx, table, geoObjectId);

      const update = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`update ${sql.identifier(table)} set created_at = now() - interval '1 day' where id = ${id}`),
      );
      expect(update).toMatch(new RegExp(`${table} is append-only`));
      const del = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`),
      );
      expect(del).toMatch(new RegExp(`${table} is append-only`));
    });
  });

  it("(geo_object_id, version) is unique for profiles", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      await tx.insert(profiles).values(profileValues(geoObjectId, 1));
      await tx.insert(profiles).values(profileValues(geoObjectId, 2));

      const message = await rejectionMessage(tx, (sp) => sp.insert(profiles).values(profileValues(geoObjectId, 1)));
      expect(message).toMatch(/profiles_geo_object_version_unique/);
    });
  });

  it("a profile version below 1 and a confidence outside 0..1 are rejected", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const version = await rejectionMessage(tx, (sp) => sp.insert(profiles).values(profileValues(geoObjectId, 0)));
      expect(version).toMatch(/profiles_version_positive/);
      const confidence = await rejectionMessage(tx, (sp) =>
        sp.insert(profiles).values({ ...profileValues(geoObjectId, 1), confidence: 1.2 }),
      );
      expect(confidence).toMatch(/profiles_confidence_range/);
      // A profile without any confidence group has no confidence.
      await expect(
        tx.insert(profiles).values({ ...profileValues(geoObjectId, 1), confidence: null }),
      ).resolves.toBeTruthy();
    });
  });

  it("seq increases with every change event", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const insert = async () => {
        const [row] = await tx
          .insert(changeEvents)
          .values({ geoObjectId, type: "place_new", severity: "info" })
          .returning({ seq: changeEvents.seq, details: changeEvents.details, profileVersion: changeEvents.profileVersion });
        return row!;
      };
      const first = await insert();
      const second = await insert();
      expect(typeof first.seq).toBe("number");
      expect(second.seq).toBeGreaterThan(first.seq);
      expect(first.details).toEqual({});
      expect(first.profileVersion).toBeNull();
    });
  });

  it("only one ok summary per (geo object, profile version, prompt version); an empty one may be redone", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const base = { geoObjectId, profileVersion: 1, attempts: 3, model: "m", promptVersion: 1 };
      await tx.insert(profileSummaries).values({ ...base, text: null, status: "empty" });
      await tx.insert(profileSummaries).values({ ...base, text: null, status: "empty" });
      await tx.insert(profileSummaries).values({ ...base, text: "Eine Bucht.", status: "ok" });

      const message = await rejectionMessage(tx, (sp) =>
        sp.insert(profileSummaries).values({ ...base, text: "Noch eine.", status: "ok" }),
      );
      expect(message).toMatch(/profile_summaries_ok_unique/);
      // Another prompt version may summarise the same profile version.
      await expect(
        tx.insert(profileSummaries).values({ ...base, promptVersion: 2, text: "Eine Bucht.", status: "ok" }),
      ).resolves.toBeTruthy();
    });
  });

  it("a change event records its transaction id; the visibility filter hides rows of transactions still in flight", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const [row] = await tx
        .insert(changeEvents)
        .values({ geoObjectId, type: "place_new", severity: "info" })
        .returning({ id: changeEvents.id, xactId: changeEvents.xactId });
      expect(row!.xactId).toMatch(/^\d+$/);
      const current = await tx.execute<{ xid: string }>(sql`select pg_current_xact_id()::text as xid`);
      expect(row!.xactId).toBe(current.rows[0]!.xid);
      // This transaction is still running, so its own event is not yet safe to hand out.
      const visible = await tx.select({ id: changeEvents.id }).from(changeEvents).where(visibleChangeEventsFilter());
      expect(visible.map((v) => v.id)).not.toContain(row!.id);
    });
  });

  it("a profile version may not start before the latest valid_from of its object", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const otherId = await insertGeoObject(tx);
      await tx.insert(profiles).values(profileValues(geoObjectId, 1, "2026-10-19"));
      const message = await rejectionMessage(tx, (sp) =>
        sp.insert(profiles).values(profileValues(geoObjectId, 2, "2026-10-18")),
      );
      expect(message).toMatch(/valid_from.*precedes/);
      // The same day and a later day are fine, and other objects are independent.
      await tx.insert(profiles).values(profileValues(geoObjectId, 2, "2026-10-19"));
      await tx.insert(profiles).values(profileValues(geoObjectId, 3, "2026-11-01"));
      await tx.insert(profiles).values(profileValues(otherId, 1, "2026-01-01"));
    });
  });

  it("summary rows must be complete: ok needs text and prompt version, empty has no text, attempts >= 0", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const base = { geoObjectId, profileVersion: 1, attempts: 1, model: "m", promptVersion: 1 };
      const noText = await rejectionMessage(tx, (sp) =>
        sp.insert(profileSummaries).values({ ...base, text: null, status: "ok" }),
      );
      expect(noText).toMatch(/profile_summaries_ok_complete/);
      const noPrompt = await rejectionMessage(tx, (sp) =>
        sp.insert(profileSummaries).values({ ...base, promptVersion: null, text: "Eine Bucht.", status: "ok" }),
      );
      expect(noPrompt).toMatch(/profile_summaries_ok_complete/);
      const emptyText = await rejectionMessage(tx, (sp) =>
        sp.insert(profileSummaries).values({ ...base, text: "Doch Text.", status: "empty" }),
      );
      expect(emptyText).toMatch(/profile_summaries_empty_no_text/);
      const attempts = await rejectionMessage(tx, (sp) =>
        sp.insert(profileSummaries).values({ ...base, attempts: -1, text: null, status: "rejected" }),
      );
      expect(attempts).toMatch(/profile_summaries_attempts_nonnegative/);
      // A rejected summary may keep its text for the audit trail, and may lack a prompt version.
      await expect(
        tx.insert(profileSummaries).values({ ...base, promptVersion: null, attempts: 0, text: "Abgelehnt.", status: "rejected" }),
      ).resolves.toBeTruthy();
    });
  });
});
