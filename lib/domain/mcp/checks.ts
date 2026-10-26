import type { Db } from "@/lib/db/client";
import { workerHeartbeats } from "@/lib/db/schema";
import { checkGazetteer, type GazetteerCheck } from "@/lib/domain/acceptance/gazetteer";
import { checkGeometry, type GeometryCheck } from "@/lib/domain/geometry/check";
import { queuesView, type JobsView } from "@/lib/domain/queues-view";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";

/** The two acceptance checks of a subdivision: gazetteer coverage of its tile box and its geometry. */
export async function subdivisionChecks(db: Db, key: string): Promise<{ gazetteer: GazetteerCheck; geometry: GeometryCheck }> {
  const sub = await requireSubdivision(db, key);
  return { gazetteer: await checkGazetteer(db, sub.bbox), geometry: await checkGeometry(db, key) };
}

export type WorkerStatus = {
  heartbeats: Array<{ workerId: string; host: string; startedAt: Date; beatAt: Date; ageSeconds: number }>;
  queues: JobsView;
};

/** Worker heartbeats with their age in seconds, and the queue stats. */
export async function workerStatus(db: Db, now: Date = new Date()): Promise<WorkerStatus> {
  const rows = await db.select().from(workerHeartbeats).orderBy(workerHeartbeats.workerId);
  return {
    heartbeats: rows.map((r) => ({ ...r, ageSeconds: Math.max(0, Math.round((now.getTime() - r.beatAt.getTime()) / 1000)) })),
    queues: await queuesView(db),
  };
}
