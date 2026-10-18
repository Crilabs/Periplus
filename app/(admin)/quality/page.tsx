import Link from "next/link";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { COMPARISON_TARGET, comparisonOverview } from "@/lib/domain/comparison";
import { requireAdmin } from "@/lib/security/require-admin";
import { PLACE_KIND_LABELS } from "../_components/labels";
import { toggleComparisonAction } from "./actions";

const querySchema = z.object({
  area: z.string().optional().catch(undefined),
  tile: z.string().optional().catch(undefined),
});

export default async function Page({ searchParams }: PageProps<"/quality">) {
  await requireAdmin();
  const areas = getConfig().areas;
  const query = querySchema.parse(await searchParams);
  const area = areas.find((a) => a.key === query.area) ?? areas[0];
  if (!area) return <p className="text-sm">Kein Revier konfiguriert.</p>;
  const overview = await comparisonOverview(getDb(), area.key);
  const { candidates, size } = overview ?? { candidates: [], size: 0 };
  const tileIds = [...new Set(candidates.flatMap((c) => (c.tileId ? [c.tileId] : [])))];
  const tile = tileIds.includes(query.tile ?? "") ? query.tile : undefined;
  const shown = tile ? candidates.filter((c) => c.tileId === tile) : candidates;
  const href = (t?: string) => `/quality?${new URLSearchParams({ area: area.key, ...(t ? { tile: t } : {}) })}`;

  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold">Qualität</h1>
      <section className="space-y-3">
        <h2 className="font-semibold">Vergleichssatz</h2>
        <p>
          <span data-testid="comparison-count" className="tabular-nums font-semibold">
            {size} von {COMPARISON_TARGET}
          </span>{" "}
          Orten im Revier {area.names.de}
        </p>
        <p className="text-neutral-600">Nur Ortsliste, keine Navily-Daten übernehmen.</p>
        {areas.length > 1 && (
          <ul aria-label="Revier" className="flex flex-wrap gap-x-4">
            {areas.map((a) => (
              <li key={a.key}>
                <Link href={`/quality?area=${a.key}`} className={a.key === area.key ? "font-semibold" : "hover:underline"}>
                  {a.names.de}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <ul aria-label="Kachel" className="flex flex-wrap gap-x-4 gap-y-1">
          <li>
            <Link href={href()} className={tile ? "hover:underline" : "font-semibold"}>
              Alle Kacheln
            </Link>
          </li>
          {tileIds.map((t) => (
            <li key={t}>
              <Link href={href(t)} className={t === tile ? "font-semibold" : "hover:underline"}>
                {t}
              </Link>
            </li>
          ))}
        </ul>
        {!overview ? (
          <p data-testid="area-missing">
            Revier noch nicht angelegt –{" "}
            <Link href="/runs" className="underline">
              Gazetteer-Lauf starten
            </Link>
          </p>
        ) : shown.length === 0 ? (
          <p>Keine bestätigten Orte.</p>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {shown.map((c) => (
              <li key={c.placeId}>
                <form action={toggleComparisonAction} className="flex items-center gap-3 py-1">
                  <input type="hidden" name="placeId" value={c.placeId} />
                  <input type="hidden" name="areaKey" value={area.key} />
                  <input
                    type="checkbox"
                    name="include"
                    value="true"
                    defaultChecked={c.inSet}
                    aria-label={`${c.name ?? c.placeId} im Vergleichssatz`}
                  />
                  <Link href={`/places/${c.placeId}`} className="underline">
                    {c.name ?? c.placeId}
                  </Link>
                  <span>{PLACE_KIND_LABELS[c.kind]}</span>
                  <span className="font-mono text-xs">{c.tileId}</span>
                  <button type="submit" className="ml-auto hover:underline">
                    Übernehmen
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
