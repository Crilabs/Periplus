import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import type { ReviewKind } from "@/lib/db/schema";
import { OFFERED_REVIEW_KINDS } from "@/lib/domain/review";
import { listOpenTasks, reviewCounts } from "@/lib/domain/review-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { COMPARISON_ATTRIBUTE_LABELS, REVIEW_KIND_LABELS, RUN_NOT_STARTED_NOTICE } from "../_components/labels";
import {
  Badge,
  ButtonLink,
  cx,
  EmptyState,
  FilterChips,
  fmt,
  Notice,
  numClass,
  PageHeader,
  Panel,
  Table,
  tdClass,
  thClass,
  trClass,
} from "../_components/ui";
import { REVIEW_KIND_HELP } from "./kinds";

export const metadata: Metadata = { title: "Prüfen" };

const PAGE_SIZE = 50;
const querySchema = z.object({
  kind: z.enum(OFFERED_REVIEW_KINDS as [ReviewKind, ...ReviewKind[]]).optional().catch(undefined),
  before: z.uuid().optional().catch(undefined),
  notice: z.literal("run_not_started").optional().catch(undefined),
  /** Comparison deviations of evaluation runs only (`only`) or without them (`none`). */
  evaluation: z.enum(["only", "none"]).optional().catch(undefined),
});

/** The attribute of a list row in German: profile attributes come labelled, comparison attributes by key. */
const attributeText = (kind: string, attribute: string | null) =>
  attribute === null
    ? null
    : kind === "comparison_deviation" && Object.hasOwn(COMPARISON_ATTRIBUTE_LABELS, attribute)
      ? COMPARISON_ATTRIBUTE_LABELS[attribute as keyof typeof COMPARISON_ATTRIBUTE_LABELS]
      : attribute;

/** Like FilterChips, but each chip's accessible name is "<Art>: <Zahl>" and the count keeps its test id. */
function KindChips({ items }: { items: Array<{ href: string; label: string; count: number; current: boolean; testId?: string }> }) {
  return (
    <ul aria-label="Offene Aufgaben je Art" className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            aria-label={`${item.label}: ${item.count}`}
            aria-current={item.current ? "true" : undefined}
            className={cx(
              "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm transition-colors",
              item.current
                ? "border-accent bg-accent-soft font-medium text-accent"
                : item.count === 0
                  ? "border-line bg-surface text-muted hover:border-line-strong"
                  : "border-line bg-surface text-ink hover:border-line-strong",
            )}
          >
            {item.label}
            <span data-testid={item.testId} className={cx("tabular-nums", item.current ? "" : "text-muted")}>
              {item.count}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function Page({ searchParams }: PageProps<"/review">) {
  await requireAdmin();
  const { kind, before, notice, evaluation } = querySchema.parse(await searchParams);
  const db = getDb();
  const [counts, tasks] = await Promise.all([reviewCounts(db), listOpenTasks(db, { kind, evaluation, limit: PAGE_SIZE, before })]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const href = (q: { kind?: string; evaluation?: string; before?: string }) => {
    const params = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined));
    return params.size > 0 ? `/review?${params}` : "/review";
  };
  const filter = (k?: string) => href({ kind: k, evaluation });
  const more = tasks.length === PAGE_SIZE ? href({ kind, evaluation, before: tasks.at(-1)!.id }) : null;
  const evaluationKinds = !kind || kind === "comparison_deviation";
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Prüfen"
        description="Aufgaben, die die Pipeline nicht allein entscheiden darf. Jede Aufgabe zeigt oben die Entscheidung und darunter die Belege; auf der Aufgabe entscheiden die Tasten 1–4, n springt zur nächsten."
        actions={
          tasks.length > 0 && (
            <ButtonLink href={`/review/${tasks[0]!.id}`} variant="primary">
              Erste Aufgabe bearbeiten
            </ButtonLink>
          )
        }
      />

      {notice && (
        <Notice tone="warn" className="mb-4">
          {RUN_NOT_STARTED_NOTICE}
        </Notice>
      )}

      <div className="mb-4">
        <KindChips
          items={[
            { href: filter(), label: "Alle", count: total, current: !kind },
            ...OFFERED_REVIEW_KINDS.map((k) => ({
              href: filter(k),
              label: REVIEW_KIND_LABELS[k],
              count: counts[k],
              current: kind === k,
              testId: `count-${k}`,
            })),
          ]}
        />
      </div>

      {evaluationKinds && counts.comparison_deviation > 0 && (
        <div className="mb-4">
          <FilterChips
            label="Abweichungen aus Bewertungsläufen"
            items={[
              { href: href({ kind }), label: "Alle", current: !evaluation },
              { href: href({ kind, evaluation: "none" }), label: "Ohne Bewertung", current: evaluation === "none" },
              { href: href({ kind, evaluation: "only" }), label: "Nur Bewertung", current: evaluation === "only" },
            ]}
          />
        </div>
      )}

      <Panel
        title={kind ? REVIEW_KIND_LABELS[kind] : "Offene Aufgaben"}
        description={
          kind ? REVIEW_KIND_HELP[kind] : "Höchste Priorität zuerst, bei gleicher Priorität die älteste Aufgabe."
        }
        flush
      >
        {tasks.length === 0 ? (
          <EmptyState title="Keine offenen Aufgaben.">
            {before
              ? "Nach dieser Stelle der Liste kommt nichts mehr."
              : "Neue Aufgaben entstehen, sobald ein Lauf etwas findet, das er nicht allein entscheiden darf."}
          </EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th className={thClass}>Gegenstand</th>
                  {!kind && <th className={thClass}>Art</th>}
                  <th className={cx(thClass, "text-right")} title="Höhere Priorität kommt früher in der Warteschlange">
                    Priorität
                  </th>
                  <th className={cx(thClass, "text-right")}>Erstellt</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id} className={trClass}>
                    <td className={tdClass}>
                      <Link
                        href={`/review/${t.id}`}
                        className={cx(
                          "text-accent underline-offset-2 hover:underline",
                          t.name === null ? "font-mono text-[0.8125rem] break-all" : "font-medium",
                        )}
                      >
                        {t.name ?? t.subjectId}
                      </Link>
                      {attributeText(t.kind, t.attribute) && <span className="ml-1.5 text-muted">· {attributeText(t.kind, t.attribute)}</span>}
                      {t.evaluation && (
                        <span className="ml-2" title="Abweichung eines Bewertungslaufs (Kandidat für eine neue Konfiguration), nicht des laufenden Profils">
                          <Badge tone="neutral">Bewertung</Badge>
                        </span>
                      )}
                    </td>
                    {!kind && (
                      <td className={tdClass}>
                        <Badge>{REVIEW_KIND_LABELS[t.kind]}</Badge>
                      </td>
                    )}
                    <td className={cx(tdClass, numClass)}>{t.priority}</td>
                    <td className={cx(tdClass, numClass, "text-muted")}>
                      <span title={fmt.dateTime(t.createdAt)}>{fmt.ago(t.createdAt, now)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {more && (
              <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
                <span>Die ersten {PAGE_SIZE} Aufgaben ab dieser Stelle.</span>
                <ButtonLink href={more} size="sm">
                  Weitere
                </ButtonLink>
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
