"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { pauseQueue, resumeQueue } from "@/lib/jobs/controls";
import { QUEUES } from "@/lib/jobs/queues";
import { requireAdmin } from "@/lib/security/require-admin";

const queueSchema = z.object({ queue: z.enum(QUEUES) });

function parseQueue(input: FormData | { queue: string }): string {
  return queueSchema.parse(input instanceof FormData ? Object.fromEntries(input) : input).queue;
}

export async function pauseQueueAction(input: FormData | { queue: string }): Promise<void> {
  const admin = await requireAdmin();
  await pauseQueue(getDb(), parseQueue(input), null, "manual", admin.email);
  revalidatePath("/jobs");
}

export async function resumeQueueAction(input: FormData | { queue: string }): Promise<void> {
  const admin = await requireAdmin();
  await resumeQueue(getDb(), parseQueue(input), admin.email);
  revalidatePath("/jobs");
}
