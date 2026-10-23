import type { Metadata } from "next";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { deliveryArchive } from "@/lib/domain/delivery/archive";
import { listHomeMarinas } from "@/lib/domain/delivery/radius/home-marinas";
import { listRadiusPackages, previewRadius, radiusMapFeatures, RADIUS_PACKAGES_PAGE_SIZE } from "@/lib/domain/delivery/radius/view";
import { createLogger } from "@/lib/logger";
import { requireAdmin } from "@/lib/security/require-admin";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  Field,
  fmt,
  inputClass,
  Mono,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Table,
  tdClass,
  thClass,
  trClass,
} from "../../_components/ui";
import { RadiusMap, RadiusZipButton } from "./radius-map";

export const metadata: Metadata = { title: "Umkreis-Paket" };

const pageParam = z.coerce.number().int().min(1).catch(1);
const marinaParam = z.string().min(1).optional().catch(undefined);
const daysParam = z.coerce.number().int().optional().catch(undefined);

const formatBytes = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1).replace(".", ",")} MB` : `${fmt.int(Math.max(1, Math.round(n / 1024)))} kB`);

const OBJECT_LABELS: Array<[string, string]> = [
  ["spots", "Spots"],
  ["highlights", "Highlights"],
  ["regions", "Regionen"],
  ["weatherPoints", "Wetterpunkte"],
  ["coastFeatures", "Küstenobjekte"],
];

/** The preview, or the error of a failing build or read (shown on the page, not as a bare 500). */
function previewOrError(
  db: ReturnType<typeof getDb>,
  archive: ReturnType<typeof deliveryArchive>,
  marina: string,
  days: number,
): Promise<Awaited<ReturnType<typeof previewRadius>> | { error: string }> {
  return previewRadius(db, archive, marina, days).catch((e: unknown) => {
    const error = e instanceof Error ? e.message : String(e);
    createLogger("admin-radius").error({ marina, days, reason: error }, "radius preview failed");
    return { error };
  });
}

export default async function Page({ searchParams }: PageProps<"/deliveries/radius">) {
  await requireAdmin();
  const sp = await searchParams;
  const marina = marinaParam.parse(sp.marina);
  const days = daysParam.parse(sp.days);
  const page = pageParam.parse(sp.page);
  const db = getDb();
  const archive = deliveryArchive();
  const { minDays, maxDays, nmPerDay, returnFactor } = getConfig().delivery.radius;

  // an unreadable package must not take the cached list and the preview down: show the error, offer no marinas
  const homeMarinas = listHomeMarinas(db, archive).then(
    (list) => ({ list, error: null as string | null }),
    (e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      createLogger("admin-radius").error({ reason: error }, "home marinas could not be listed");
      return { list: [], error };
    },
  );
  const [{ list: marinas, error: marinasError }, packages, preview] = await Promise.all([
    homeMarinas,
    listRadiusPackages(db, page),
    marina && days !== undefined ? previewOrError(db, archive, marina, days) : Promise.resolve(null),
  ]);
  const result = preview && typeof preview !== "string" && !("error" in preview) ? preview : null;
  const previewError = preview && typeof preview !== "string" && "error" in preview ? preview.error : null;
  const features = result ? await radiusMapFeatures(db, result.manifest) : null;
  const missing = result?.manifest.coverage.filter((c) => c.status === "missing") ?? [];

  return (
    <>
      <PageHeader
        title="Umkreis-Paket"
        back={{ href: "/deliveries", label: "Lieferungen" }}
        description={`Prüfung vor dem ersten Abnehmer: das Paket, das ein Abnehmer für eine Heimatmarina und eine Törndauer bekäme. Radius = ${fmt.int(nmPerDay)} sm × Tage × ${String(returnFactor).replace(".", ",")}. Die Vorschau baut das Paket, falls es noch nicht zwischengespeichert ist.`}
      />

      <Panel title="Vorschau" className="mb-6">
        <form method="get" className="flex flex-wrap items-end gap-4">
          <Field label="Heimatmarina" className="min-w-64">
            <select name="marina" defaultValue={marina ?? ""} required className={inputClass}>
              <option value="" disabled>
                Marina wählen …
              </option>
              {marinas.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.subdivision})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tage" hint={`${minDays} bis ${maxDays}`}>
            <input name="days" type="number" min={minDays} max={maxDays} step={1} defaultValue={days ?? Math.min(7, maxDays)} required className={cx(inputClass, "w-24")} />
          </Field>
          <Button variant="primary">Vorschau</Button>
        </form>
        {marinasError && (
          <Notice tone="danger" className="mt-4">
            Heimatmarinas konnten nicht gelesen werden, die Auswahl ist leer: {marinasError}. Eine Vorschau geht weiter über <Mono>?marina=sp_…&amp;days=…</Mono>.
          </Notice>
        )}
        {!marinasError && marinas.length === 0 && <p className="mt-3 text-sm text-muted">Noch keine Heimatmarina in einem gültigen Paket.</p>}

        {typeof preview === "string" && (
          <Notice tone="danger" className="mt-4">
            {preview === "invalid_days"
              ? `Tage müssen eine ganze Zahl von ${minDays} bis ${maxDays} sein.`
              : "Marina nicht gefunden: sie ist in keinem gültigen Paket als Marina geliefert."}
          </Notice>
        )}
        {previewError && (
          <Notice tone="danger" className="mt-4">
            Die Vorschau ist fehlgeschlagen: {previewError}
          </Notice>
        )}
      </Panel>

      {result && features && (
        <Panel
          title={`${result.manifest.scope.type === "radius" ? result.manifest.scope.homeMarina.name : ""}, ${result.row.days} Tage, ${fmt.int(Math.round(result.row.radiusNm))} sm`}
          description={
            <>
              Schlüssel <Mono>{result.row.key}</Mono> · Stand {fmt.dateTime(result.row.generatedAt)}
            </>
          }
          actions={<RadiusZipButton marina={result.row.homeMarinaPublicId} days={result.row.days} />}
          className="mb-6"
        >
          {missing.length > 0 && (
            <Notice tone="warn" className="mb-4">
              Landesteile ohne gültiges Paket im Umkreis: {missing.map((c) => c.name).join(", ")}. Ihre Orte fehlen im Paket.
            </Notice>
          )}
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <RadiusMap features={features} />
            <div className="space-y-5 text-sm">
              <div>
                <h3 className="mb-1.5 text-xs font-medium text-muted">Landesteile</h3>
                <ul className="space-y-1">
                  {result.manifest.coverage.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3">
                      <span>{c.name}</span>
                      <Badge tone={c.status === "delivered" ? "ok" : "warn"}>
                        {c.status === "delivered" ? `geliefert · Version ${c.dataVersion}` : "fehlt"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-1.5 text-xs font-medium text-muted">Objekte je Datei</h3>
                <ul className="space-y-1 tabular-nums">
                  {OBJECT_LABELS.map(([k, label]) => (
                    <li key={k} className="flex justify-between gap-3">
                      <span>{label}</span>
                      <span>{fmt.int(result.manifest.objectCounts[k as keyof typeof result.manifest.objectCounts] ?? 0)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-1.5 text-xs font-medium text-muted">Größe</h3>
                <p className="tabular-nums">
                  <span className="font-semibold">{formatBytes(result.totalBytes)}</span>
                  <span className="text-muted"> · {fmt.int(Object.keys(result.row.fileHashes).length)} Dateien</span>
                </p>
                <ul className="mt-1.5 space-y-0.5 text-xs text-muted tabular-nums">
                  {Object.entries(result.row.fileHashes).map(([name, h]) => (
                    <li key={name} className="flex justify-between gap-3">
                      <span className="truncate">{name}</span>
                      <span>{formatBytes(h.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {result.row.warnings.length > 0 && (
                <Notice tone="warn">
                  {result.row.warnings.length} Warnung(en) beim Zusammenführen: {result.row.warnings.join("; ")}
                </Notice>
              )}
            </div>
          </div>
        </Panel>
      )}

      <Panel title="Zwischengespeicherte Umkreis-Pakete" description="Neueste zuerst. Abrufe: Paket-, Datei- und Änderungsabrufe, auch die Vorschau hier." flush>
        {packages.length === 0 ? (
          <EmptyState title="Noch kein Umkreis-Paket">Das erste Paket entsteht mit der ersten Vorschau oder dem ersten Abruf.</EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th className={thClass}>Marina</th>
                  <th className={cx(thClass, "text-right")}>Tage</th>
                  <th className={thClass}>Schlüssel</th>
                  <th className={thClass}>Stand</th>
                  <th className={cx(thClass, "text-right")}>Abrufe</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((p) => (
                  <tr key={p.key} className={trClass}>
                    <td className={tdClass}>
                      <a className="text-accent underline-offset-2 hover:underline" href={`/deliveries/radius?marina=${p.marina}&days=${p.days}`}>
                        <Mono>{p.marina}</Mono>
                      </a>
                    </td>
                    <td className={cx(tdClass, "text-right tabular-nums")}>{p.days}</td>
                    <td className={tdClass}>
                      <Mono>{p.key}</Mono>
                    </td>
                    <td className={cx(tdClass, "whitespace-nowrap")}>{fmt.dateTime(new Date(p.generatedAt))}</td>
                    <td className={cx(tdClass, "text-right tabular-nums")}>{fmt.int(p.requests)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {(page > 1 || packages.length === RADIUS_PACKAGES_PAGE_SIZE) && (
              <Pagination
                page={page}
                pages={packages.length === RADIUS_PACKAGES_PAGE_SIZE ? page + 1 : page}
                total={(page - 1) * RADIUS_PACKAGES_PAGE_SIZE + packages.length}
                noun="Pakete"
                href={(p) => `/deliveries/radius${p > 1 ? `?page=${p}` : ""}`}
              />
            )}
          </>
        )}
      </Panel>
    </>
  );
}
