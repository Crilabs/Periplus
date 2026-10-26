"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { retryJobWithTask } from "@/lib/domain/job-retry";
import { getBoss } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { endRunByAdmin } from "@/lib/pipeline/runs";
import { afterBuildRunEnded } from "@/lib/pipeline/subdivision-build";
import { requireAdmin } from "@/lib/security/require-admin";

const retrySchema = z.object({ queue: z.enum(QUEUES), jobId: z.uuid() });

/** Retries a failed job; an open `failed_job` task of the job is decided with `retry` along the way (`retryJobWithTask`). */
export async function retryJobAction(input: FormData | { queue: string; jobId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { queue, jobId } = retrySchema.parse(input instanceof FormData ? Object.fromEntries(input) : input);
  await retryJobWithTask(getDb(), await getBoss(), { queue, jobId, decidedBy: admin.email });
  refresh();
}

const endRunSchema = z.object({ runId: z.uuid() });

/**
 * "Lauf beenden": ends a queued or running run (e.g. one stuck after a worker crash, which keeps its sources locked)
 * and cancels its jobs that have not started; records the admin and the time on the run. For a run an admin ended
 * whose cleanup did not complete, „Aufräumen wiederholen“ runs the cleanup again; any other ended run stays as it is.
 */
export async function endRunAction(input: FormData | { runId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { runId } = endRunSchema.parse(input instanceof FormData ? Object.fromEntries(input) : input);
  const db = getDb();
  const boss = await getBoss();
  const { ended } = await endRunByAdmin(db, boss, runId, admin.email);
  // an ended subdivision build leaves the queue, and the next queued subdivision of its country starts
  if (ended) await afterBuildRunEnded(db, boss, runId);
  refresh();
}
