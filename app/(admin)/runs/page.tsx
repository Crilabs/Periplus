import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { listRuns } from "@/lib/domain/runs";
import { requireAdmin } from "@/lib/security/require-admin";
import { AutoRefresh } from "../_components/auto-refresh";
import { runScopeError } from "../_components/labels";
import { RunsTable } from "../_components/runs-table";
import { startDatasetImportAction, startGazetteerAction, startGeometryAction, startPingRun, startSeedAction } from "./actions";

const BUTTON = "rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100";
const SELECT = "rounded border border-neutral-400 px-2 py-1";

export default async function Page({ searchParams }: PageProps<"/runs">) {
  await requireAdmin();
  const error = runScopeError((await searchParams).error);
  const runs = await listRuns(getDb(), { limit: 50 });
  const areas = getConfig().areas.map((a) => ({ key: a.key, name: a.names.de ?? a.key }));
  const areaOptions = areas.map((a) => (
    <option key={a.key} value={a.key}>
      {a.name}
    </option>
  ));
  return (
    <div className="space-y-4 text-sm">
      <AutoRefresh intervalMs={5000} />
      <h1 className="text-lg font-semibold">Läufe</h1>
      {error && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Lauf nicht gestartet: {error}
        </p>
      )}
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
        <button type="submit" className={BUTTON}>
          Ping-Lauf starten
        </button>
      </form>
      <form action={startGazetteerAction} className="flex items-center gap-2">
        <label htmlFor="gazetteer-area">Revier</label>
        <select id="gazetteer-area" name="areaKey" required className={SELECT}>
          {areaOptions}
        </select>
        <button type="submit" className={BUTTON}>
          Gazetteer aufbauen
        </button>
      </form>
      <form action={startSeedAction} className="flex items-center gap-2">
        <label htmlFor="seed-area">Revier</label>
        <select id="seed-area" name="areaKey" required className={SELECT}>
          {areaOptions}
        </select>
        <button type="submit" className={BUTTON}>
          Seed für Revier
        </button>
      </form>
      <form action={startDatasetImportAction} className="flex items-center gap-2">
        <label htmlFor="datasets-area">Revier</label>
        <select id="datasets-area" name="areaKey" required className={SELECT}>
          {areaOptions}
        </select>
        <button type="submit" className={BUTTON}>
          Datensätze laden
        </button>
      </form>
      <form action={startGeometryAction} className="flex items-center gap-2">
        <label htmlFor="geometry-area">Revier</label>
        <select id="geometry-area" name="areaKey" required className={SELECT}>
          {areaOptions}
        </select>
        <button type="submit" className={BUTTON}>
          Geometrie für Revier
        </button>
      </form>
      <RunsTable runs={runs} />
    </div>
  );
}
