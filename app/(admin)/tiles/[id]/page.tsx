import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { tileDetail } from "@/lib/domain/geo-view";
import { requireAdmin } from "@/lib/security/require-admin";
import {
  GEO_OBJECT_TYPE_LABELS,
  PLACE_KIND_LABELS,
  PLACE_STATUS_LABELS,
  RUN_KIND_LABELS,
  RUN_STATUS_LABELS,
  runScopeError,
  SCOPE_TYPE_LABELS,
} from "../../_components/labels";
import { discoveryForTileAction, geometryTileAction, seedTileAction } from "./actions";

const TILE_ID = /^q025:\d+:\d+$/;
const time = (d: Date | null) => (d ? d.toISOString().slice(0, 19).replace("T", " ") : "–");
const eur = (n: number) => `${n.toFixed(4)} €`;

/** The tile id from the path; it may arrive URL-encoded (`q025%3A813%3A510`). Null when malformed. */
function tileIdParam(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw);
    return TILE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

const BUTTON = "rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100";

export default async function Page({ params, searchParams }: PageProps<"/tiles/[id]">) {
  await requireAdmin();
  const id = tileIdParam((await params).id);
  const error = runScopeError((await searchParams).error);
  if (!id) notFound();
  const detail = await tileDetail(getDb(), id);
  if (!detail) notFound();
  const { tile, area } = detail;
  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold">Kachel {tile.id}</h1>
      {error && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Lauf nicht gestartet: {error}
        </p>
      )}
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
        <dt>Revier</dt>
        <dd>
          {area ? (
            <Link href={`/geo/${area.id}`} className="underline">
              {area.name ?? area.configKey ?? area.id}
            </Link>
          ) : (
            "–"
          )}
        </dd>
        <dt>Küste</dt>
        <dd>{tile.hasCoast ? "Ja" : "Nein"}</dd>
        <dt>Priorität</dt>
        <dd>{tile.priority}</dd>
        <dt>Zyklus</dt>
        <dd>{tile.cycleDays} Tage</dd>
        <dt>Letzter Lauf</dt>
        <dd>{time(tile.lastRunAt)}</dd>
        <dt>Nächster Lauf</dt>
        <dd>{time(tile.nextRunAt)}</dd>
        {tile.validTo && (
          <>
            <dt>Gültig bis</dt>
            <dd>{tile.validTo}</dd>
          </>
        )}
        <dt>Kosten</dt>
        <dd>
          {eur(detail.costEur)}
          {detail.costs.length > 0 &&
            ` (${detail.costs.map((c) => `${c.service}: ${c.calls} Aufrufe, ${eur(c.costEur)}`).join(" · ")})`}
        </dd>
      </dl>
      <div className="flex gap-2">
        <form action={seedTileAction}>
          <input type="hidden" name="tileId" value={tile.id} />
          <button type="submit" className={BUTTON}>
            Seed
          </button>
        </form>
        <form action={geometryTileAction}>
          <input type="hidden" name="tileId" value={tile.id} />
          <button type="submit" className={BUTTON}>
            Geometrie
          </button>
        </form>
        <form action={discoveryForTileAction}>
          <input type="hidden" name="tileId" value={tile.id} />
          <button type="submit" className={BUTTON}>
            Quellenfindung
          </button>
        </form>
      </div>

      <section>
        <h2 className="mb-1 font-semibold">Orte</h2>
        {detail.places.length === 0 ? (
          <p>Keine Orte.</p>
        ) : (
          <ul>
            {detail.places.map((p) => (
              <li key={p.id}>
                <Link href={`/places/${p.id}`} className="underline">
                  {p.name ?? p.id}
                </Link>{" "}
                – {PLACE_KIND_LABELS[p.kind]}, {PLACE_STATUS_LABELS[p.status]}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Geo-Objekte</h2>
        {detail.geoObjects.length === 0 ? (
          <p>Keine Geo-Objekte.</p>
        ) : (
          <ul>
            {detail.geoObjects.map((o) => (
              <li key={o.id}>
                <Link href={`/geo/${o.id}`} className="underline">
                  {o.name ?? o.id}
                </Link>{" "}
                – {GEO_OBJECT_TYPE_LABELS[o.type]}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-semibold">Letzte Läufe</h2>
        {detail.runs.length === 0 ? (
          <p>Keine Läufe.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-1 pr-4">Lauf</th>
                <th className="pr-4">Art</th>
                <th className="pr-4">Umfang</th>
                <th className="pr-4">Stufen</th>
                <th className="pr-4">Status</th>
                <th className="pr-4">Angelegt</th>
                <th>Beendet</th>
              </tr>
            </thead>
            <tbody>
              {detail.runs.map((r) => (
                <tr key={r.id} className="border-b border-neutral-200">
                  <td className="py-1 pr-4">
                    <Link href={`/runs/${r.id}`} className="font-mono text-xs underline">
                      {r.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="pr-4">{RUN_KIND_LABELS[r.kind]}</td>
                  <td className="pr-4">
                    {SCOPE_TYPE_LABELS[r.scopeType]}: {r.scopeId}
                  </td>
                  <td className="pr-4">{r.stages.join(", ")}</td>
                  <td className="pr-4">{RUN_STATUS_LABELS[r.status]}</td>
                  <td className="pr-4 whitespace-nowrap">{time(r.createdAt)}</td>
                  <td className="whitespace-nowrap">{time(r.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
