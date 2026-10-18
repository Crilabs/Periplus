"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { retryFailedJob } from "@/lib/domain/jobs-view";
import { getBoss } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { requireAdmin } from "@/lib/security/require-admin";

const retrySchema = z.object({ queue: z.enum(QUEUES), jobId: z.uuid() });

export async function retryJobAction(input: FormData | { queue: string; jobId: string }): Promise<void> {
  await requireAdmin();
  const { queue, jobId } = retrySchema.parse(input instanceof FormData ? Object.fromEntries(input) : input);
  await retryFailedJob(await getBoss(), queue, jobId);
  refresh();
}
