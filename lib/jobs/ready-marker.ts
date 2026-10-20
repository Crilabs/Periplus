import { rmSync, utimesSync, writeFileSync } from "node:fs";

/*
 * The worker's ready marker (OPS-2): a file the worker writes once it has started (its start checks passed, its
 * queues are served) and touches on every heartbeat. The compose healthcheck and the deploy check look for a fresh
 * one, so a worker that fails at start (and restarts forever under `restart: unless-stopped`) is never reported
 * ready. A restarted container keeps its file system, so the marker is removed first thing at every start.
 */

/** Path of the marker inside the worker container (docker/compose.prod.yml, scripts/deploy/deploy.sh). */
export const WORKER_READY_FILE = "/tmp/periplus-worker-ready";

/** Removes a marker of an earlier start (or of this process on shutdown). */
export function clearReadyMarker(path: string = WORKER_READY_FILE): void {
  rmSync(path, { force: true });
}

/** Writes the marker (at start) or refreshes its time (on each heartbeat). */
export function touchReadyMarker(path: string = WORKER_READY_FILE): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    writeFileSync(path, `${process.pid}\n`);
  }
}
