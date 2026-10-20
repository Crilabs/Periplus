import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { deliveryArchive } from "@/lib/domain/delivery/archive";
import type { Finding } from "@/lib/domain/delivery/validate";
import { isContractFile } from "@/lib/domain/delivery/read";
import { deliveryDetail } from "@/lib/domain/delivery/view";
import { requireAdmin } from "@/lib/security/require-admin";
import {
  CHANGE_EVENT_LABELS,
  CHANGE_OBJECT_TYPE_LABELS,
  CHECK_LABELS,
  CONTRACT_FILE_LABELS,
  DELIVERY_STATUS_LABELS,
  SEVERITY_LABELS,
} from "../../_components/labels";
import {
  Badge,
  buttonClass,
  cx,
  DescriptionList,
  EmptyState,
  fmt,
  Mono,
  Notice,
  numClass,
  PageHeader,
  Panel,
  Table,
  tdClass,
  TextLink,
  thClass,
  trClass,
  type Tone,
} from "../../_components/ui";
import { DELIVERY_STATUS_TONES } from "../status";

export const metadata: Metadata = { title: "Lieferung" };

const SEVERITY_TONES: Record<"info" | "notable" | "safety", Tone> = { info: "neutral", notable: "warn", safety: "danger" };

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export default async function Page({ params }: PageProps<"/deliveries/[id]">) {
  await requireAdmin();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const detail = await deliveryDetail(getDb(), deliveryArchive(), id.data);
  if (!detail) notFound();
  const { row, report, changes, files, objectLinks } = detail;
  const failed = report.checks.filter((c) => !c.ok).length;
  const objectLink = (objectId: string | null): ReactNode =>
    objectId === null ? null : objectLinks[objectId] ? (
      <TextLink href={objectLinks[objectId]} className="font-mono text-[0.8125rem]">
        {objectId}
      </TextLink>
    ) : (
      <Mono>{objectId}</Mono>
    );

  return (
    <>
      <PageHeader
        title={`${detail.scopeName} – ${row.dataVersion !== null ? `Version ${row.dataVersion}` : DELIVERY_STATUS_LABELS[row.status]}`}
        back={{ href: row.subdivisionId ? `/deliveries?subdivision=${row.subdivisionId}` : "/deliveries", label: "Lieferungen" }}
        meta={
          <>
            <Badge tone={DELIVERY_STATUS_TONES[row.status]}>{DELIVERY_STATUS_LABELS[row.status]}</Badge>
            <span>{fmt.dateTime(row.generatedAt)}</span>
            <Mono>{detail.scopePublicId}</Mono>
          </>
        }
        description={
          row.status === "rejected"
            ? "Mindestens eine Prüfung hat einen Verstoß gefunden: das Paket wird nie ausgeliefert. Die Dateien bleiben zur Diagnose gespeichert."
            : row.status === "unchanged"
              ? "Alle Prüfungen bestanden, aber nichts hat sich gegenüber dem vorigen Paket geändert: keine neue Version, keine Dateien."
              : "Alle Prüfungen bestanden: das Paket ist über die API abrufbar."
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Panel
            title="Validierungsbericht"
            description={failed === 0 ? `Alle ${report.checks.length} Prüfungen bestanden.` : `${failed} von ${report.checks.length} Prüfungen mit Verstoß.`}
            flush
          >
            <ul className="divide-y divide-line">
              {report.checks.map((check) => (
                <li key={check.name} className="px-4 py-2.5 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <span>{CHECK_LABELS[check.name]}</span>
                    <Badge tone={check.ok ? "ok" : "danger"}>{check.ok ? "ok" : "Verstoß"}</Badge>
                  </div>
                  {check.findings.length > 0 && <Findings findings={check.findings} objectLink={objectLink} />}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title="Warnungen"
            description="Was beim Bau ausgelassen oder verworfen wurde. Warnungen blockieren das Paket nicht."
          >
            {report.warnings.length === 0 ? <p className="text-sm text-muted">Keine Warnungen.</p> : <Findings findings={report.warnings} objectLink={objectLink} />}
          </Panel>

          <Panel
            title={row.status === "rejected" ? "Diff zur Vorversion" : "Änderungen"}
            description={
              changes === null
                ? undefined
                : row.status === "rejected"
                  ? "Was dieses Paket gegenüber dem letzten gültigen geändert hätte (changes.json)."
                  : "Die Objekte, deren Vertragsversion gestiegen ist (changes.json)."
            }
            flush
          >
            {detail.archiveError ? (
              <div className="p-4">
                <Notice tone="danger" title="Änderungsdatei nicht lesbar">
                  Die gespeicherte changes.json fehlt im Archiv oder passt nicht zu ihrem Hash. Die Dateien lassen sich dann auch nicht herunterladen.
                </Notice>
              </div>
            ) : changes === null ? (
              <EmptyState title="Keine Änderungsdatei">
                {row.status === "unchanged" ? "Ein unverändertes Paket speichert keine Dateien." : "Das erste Paket eines Landesteils hat keine changes.json."}
              </EmptyState>
            ) : changes.length === 0 ? (
              <EmptyState title="Keine Änderungen" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={thClass}>Ereignis</th>
                    <th className={thClass}>Objekt</th>
                    <th className={thClass}>Schwere</th>
                    <th className={thClass}>Felder</th>
                    <th className={thClass}>Zusammenfassung</th>
                    <th className={cx(thClass, "text-right")}>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.objectId} className={trClass}>
                      <td className={tdClass}>{CHANGE_EVENT_LABELS[c.event]}</td>
                      <td className={tdClass}>
                        <span className="mr-2 text-xs text-muted">{CHANGE_OBJECT_TYPE_LABELS[c.objectType]}</span>
                        {objectLink(c.objectId)}
                      </td>
                      <td className={tdClass}>
                        <Badge tone={SEVERITY_TONES[c.severity]}>{SEVERITY_LABELS[c.severity]}</Badge>
                      </td>
                      <td className={cx(tdClass, "font-mono text-xs")}>{c.fields.join(", ") || "–"}</td>
                      <td className={cx(tdClass, "min-w-56")}>{c.summary.de}</td>
                      <td className={cx(tdClass, numClass)}>{c.profileVersion}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Eckdaten">
            <DescriptionList
              columns={1}
              items={[
                { label: "Datenversion", value: row.dataVersion ?? "–", hint: "Nur gültige Pakete mit Änderung bekommen eine" },
                { label: "Vertragsversion", value: row.schemaVersion },
                {
                  label: "Lauf",
                  value: row.runId ? (
                    <TextLink href={`/runs/${row.runId}`} className="font-mono text-[0.8125rem]">
                      {row.runId.slice(0, 8)}
                    </TextLink>
                  ) : (
                    "–"
                  ),
                },
                { label: "Ausgelöst von", value: row.triggeredBy ?? "–" },
                {
                  label: "Voriges gültiges Paket",
                  value: row.previousDeliveryId ? (
                    <TextLink href={`/deliveries/${row.previousDeliveryId}`} className="font-mono text-[0.8125rem]">
                      {row.previousDeliveryId.slice(0, 8)}
                    </TextLink>
                  ) : (
                    "–"
                  ),
                },
                { label: "Speicherort", value: row.storagePrefix ? <Mono>{row.storagePrefix}</Mono> : "–" },
              ]}
            />
          </Panel>

          <Panel title="Dateien" flush>
            {files.length === 0 ? (
              <EmptyState title="Keine Dateien gespeichert" />
            ) : (
              <ul className="divide-y divide-line text-sm">
                {files.map((f) => (
                  <li key={f.name} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {isContractFile(f.name) ? CONTRACT_FILE_LABELS[f.name] : "Bild"} <Mono>{f.name}</Mono>
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted" title={`sha256 ${f.sha256}`}>
                        {bytes(f.bytes)} · <span className="font-mono">{f.sha256.slice(0, 16)}…</span>
                      </p>
                    </div>
                    <a href={`/deliveries/${row.id}/files/${f.name}`} download className={buttonClass("secondary", "sm")}>
                      Download
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function Findings({ findings, objectLink }: { findings: Finding[]; objectLink: (id: string | null) => ReactNode }) {
  return (
    <ul className="mt-2 space-y-1.5 text-xs">
      {findings.map((f, i) => (
        <li key={i} className="rounded-md bg-sunken/60 px-2.5 py-1.5">
          <p className="text-ink">{f.message}</p>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-muted">
            <span className="font-mono">{f.file}</span>
            {f.path && <span className="font-mono">{f.path}</span>}
            {objectLink(f.objectId)}
          </p>
        </li>
      ))}
    </ul>
  );
}
