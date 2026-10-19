import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoNames, nameCandidates, places, reviewTasks, unmatchedNames } from "@/lib/db/schema";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { detailFeatures, reviewTaskDetail } from "@/lib/domain/review-view";
import { tileIdFor } from "@/lib/domain/tiles";
import { collectNameCandidates, geocodeCandidate } from "@/lib/pipeline/text/geocode";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject, insertTestSource, insertTestTile, insertTestVersion } from "@/test/text";

/*
 * The review of a new name from texts: the page data (`reviewTaskDetail`) and the decision through the server action.
 * Everything runs in withRollback on the synthetic grid around 21.0° E / 35.2° N: the action's `getDb()` is the test's
 * transaction (its own transactions become savepoints).
 */

let current: Db | undefined;
const requireAdmin = vi.fn();
const redirect = vi.fn();
vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => current ?? testDb(),
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { decideAction } from "../review/[id]/actions";

testDb();
const config = loadConfig("config");
const TILE = tileIdFor(21.3, 35.45);
const ownName = () => `Xen${newId().replace(/-/g, "").slice(-12).replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!)}`;

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

/** A name in two documents of two sources, geocoded into its review task (one Nominatim hit). */
async function nameTask(tx: Db): Promise<{ taskId: string; candidateId: string; name: string }> {
  await insertTestTile(tx, TILE);
  const name = ownName();
  const versionIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const sourceId = await insertTestSource(tx);
    const v = await insertTestVersion(tx, [`<b>Achtung</b> Wir ankerten in der Bucht von ${name}, Sand auf fünf Metern.`], { sourceId });
    await tx.insert(unmatchedNames).values({
      nameNormalized: normalizeName(name),
      displayName: name,
      hint: "bay",
      documentVersionId: v.versionId,
      chunkId: v.chunkIds[0]!,
      sourceId,
      tileId: TILE,
    });
    versionIds.push(v.versionId);
  }
  const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: "texts" }, stages: [], params: { documentVersionIds: versionIds }, triggeredBy: "test" });
  const [candidateId] = await collectNameCandidates(tx, runId, config);
  const answer = [{ osm_type: "node", osm_id: 7, lat: "35.41", lon: "21.31", category: "natural", type: "bay", name: `${name} Bay`, display_name: name }];
  const transport: Transport = async () => makeResponse(200, new TextEncoder().encode(JSON.stringify(answer)));
  let t = Date.UTC(2031, 0, 1);
  const result = await geocodeCandidate(tx, candidateId!, { transport, http: { now: () => new Date((t += 1000)) } }, { runId, cfg: config });
  return { taskId: result!.taskId, candidateId: candidateId!, name };
}

beforeEach(() => {
  vi.resetAllMocks();
  requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
  current = undefined;
});

describe("review of a new name", () => {
  it("shows occurrences, hits, the candidate space and the object a place would create", () =>
    withRollback(async (tx) => {
      const { taskId, name } = await nameTask(tx);
      const neighbour = await insertTestTile(tx, tileIdFor(21.55, 35.45));
      const far = await insertTestTile(tx, tileIdFor(21.8, 35.45));
      const near = await insertNamedObject(tx, { type: "bay", names: [{ name: "Near Bay" }], lon: 21.6, lat: 35.4, tiles: [neighbour] });
      const away = await insertNamedObject(tx, { type: "bay", names: [{ name: "Far Bay" }], lon: 21.85, lat: 35.4, tiles: [far] });

      const detail = await reviewTaskDetail(tx, taskId);
      const s = detail!.subject;
      if (s.type !== "name_candidate") throw new Error(`subject ${s.type}`);
      expect(s.candidate).toMatchObject({ name, hint: "bay", tileId: TILE, status: "review", documents: 2, sources: 2 });
      expect(s.hits).toMatchObject([{ osmId: "node/7", name: `${name} Bay`, lon: 21.31, lat: 35.41 }]);
      expect(s.occurrences).toHaveLength(2);
      for (const o of s.occurrences) {
        expect(o.snippet.slice(o.start, o.end)).toBe(name);
        expect(o.url).toMatch(/^https:\/\/.+\.test\.invalid\/page$/);
      }
      const objectIds = s.objects.map((o) => o.id);
      expect(objectIds).toContain(near);
      expect(objectIds).not.toContain(away);
      expect(s.objectTypes.anchorage).toEqual({ type: "bay", category: null });
      expect(s.tile?.id).toBe(TILE);

      const roles = detailFeatures(detail!).features.map((f) => f.properties?.role);
      // The nearest places of the whole gazetteer follow (other tests' committed places may be among them).
      expect(roles.slice(0, 2)).toEqual(["subject", "hit"]);
      expect(roles.slice(2).every((r) => r === "nearby")).toBe(true);
    }));

  it("the server action creates the place and moves on; a second click finds the task decided", () =>
    withRollback(async (tx) => {
      const { taskId, candidateId, name } = await nameTask(tx);
      current = tx;
      const decision = { action: "create_place", kind: "anchorage", position: { lon: 21.31, lat: 35.41 }, name, language: "en" };
      await decideAction(form({ taskId, decision: JSON.stringify(decision) }));
      expect(redirect).toHaveBeenCalledWith(expect.stringMatching(/^\/review(\/[0-9a-f-]+)?$/));

      const [object] = await tx.select({ id: geoNames.geoObjectId }).from(geoNames).where(eq(geoNames.name, name));
      const [place] = await tx.select({ status: places.status, publicId: places.publicId }).from(places).where(eq(places.geoObjectId, object!.id));
      expect(place).toMatchObject({ status: "confirmed" });
      expect(place!.publicId).toMatch(/^sp_/);
      expect((await tx.select().from(nameCandidates).where(eq(nameCandidates.id, candidateId)))[0]!.status).toBe("decided");
      expect((await tx.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)))[0]!.status).toBe("decided");

      await decideAction(form({ taskId, decision: JSON.stringify({ action: "reject" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/review/${taskId}?stale=1`);
    }));

  it("an object outside the candidate space redirects with error=1", () =>
    withRollback(async (tx) => {
      const { taskId } = await nameTask(tx);
      const far = await insertTestTile(tx, tileIdFor(21.8, 35.45));
      const away = await insertNamedObject(tx, { type: "bay", names: [{ name: "Far Bay" }], lon: 21.85, lat: 35.4, tiles: [far] });
      current = tx;
      await decideAction(form({ taskId, decision: JSON.stringify({ action: "assign_name", geoObjectId: away }) }));
      expect(redirect).toHaveBeenCalledWith(`/review/${taskId}?error=1`);
      expect((await tx.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)))[0]!.status).toBe("open");
    }));
});
