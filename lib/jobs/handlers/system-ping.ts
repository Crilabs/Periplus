import type { StageDefinition } from "@/lib/pipeline/runs";
import type { JobData, JobHandler } from "@/lib/jobs/worker";

/** Smoke-test stage: `params.count` (default 3) jobs keyed "0".."n-1"; keys in `params.failKeys` always fail. */
export const pingStage: StageDefinition = {
  name: "ping",
  queue: "system.ping",
  async plan(_db, run) {
    const count = typeof run.params.count === "number" ? run.params.count : 3;
    const delayMs = typeof run.params.delayMs === "number" ? run.params.delayMs : 0;
    const failKeys = Array.isArray(run.params.failKeys) ? run.params.failKeys.map(String) : [];
    return Array.from({ length: count }, (_, i) => {
      const key = String(i);
      return { key, delayMs, ...(failKeys.includes(key) ? { fail: true } : {}) };
    });
  },
};

export const pingHandler: JobHandler<JobData> = async (data, ctx) => {
  const delayMs = typeof data.delayMs === "number" ? data.delayMs : 0;
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (data.fail === true) throw new Error(`ping failed for key ${data.key}`);
  ctx.log.debug({ key: data.key }, "ping");
};
