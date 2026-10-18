import { getDb } from "@/lib/db/client";
import { listRuns } from "@/lib/domain/runs";
import { requireAdmin } from "@/lib/security/require-admin";
import { RunsTable } from "../_components/runs-table";
import { startPingRun } from "./actions";

export default async function Page() {
  await requireAdmin();
  const runs = await listRuns(getDb(), { limit: 50 });
  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold">Läufe</h1>
      <form action={startPingRun} className="flex items-center gap-2">
        <label htmlFor="count">Anzahl Pings</label>
        <input
          id="count"
          name="count"
          type="number"
          min={1}
          max={50}
          defaultValue={3}
          required
          className="w-20 rounded border border-neutral-400 px-2 py-1"
        />
        <button type="submit" className="rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100">
          Ping-Lauf starten
        </button>
      </form>
      <RunsTable runs={runs} />
    </div>
  );
}
