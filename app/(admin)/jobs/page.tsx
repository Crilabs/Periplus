import { getDb } from "@/lib/db/client";
import { queuesView } from "@/lib/domain/queues-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../_components/auto-refresh";
import { queueStateLabel } from "../_components/labels";
import { pauseQueueAction, resumeQueueAction } from "./actions";

export default async function Page() {
  await requireAdmin();
  const queues = await queuesView(getDb());
  return (
    <div className="space-y-4 text-sm">
      <AutoRefresh intervalMs={5000} />
      <h1 className="text-lg font-semibold">Jobs</h1>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-neutral-300">
            <th className="py-1 pr-4">Queue</th>
            <th className="pr-4">Wartend</th>
            <th className="pr-4">Aktiv</th>
            <th className="pr-4">Fehlgeschlagen</th>
            <th className="pr-4">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {Object.entries(queues).map(([queue, s]) => (
            <tr key={queue} className="border-b border-neutral-200">
              <td className="py-1 pr-4">{queue}</td>
              <td className="pr-4">{s.queued}</td>
              <td className="pr-4">{s.active}</td>
              <td className="pr-4">{s.failed}</td>
              <td className="pr-4">{queueStateLabel(s.paused)}</td>
              <td>
                {s.pausable && (
                  <form action={s.paused ? resumeQueueAction : pauseQueueAction}>
                    <input type="hidden" name="queue" value={queue} />
                    <button type="submit" className="underline">
                      {s.paused ? "Fortsetzen" : "Pausieren"}
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
