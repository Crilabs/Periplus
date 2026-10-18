import Link from "next/link";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { reviewKindEnum } from "@/lib/db/schema";
import { listOpenTasks, reviewCounts } from "@/lib/domain/review-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { REVIEW_KIND_LABELS } from "../_components/labels";

const PAGE_SIZE = 50;
const querySchema = z.object({
  kind: z.enum(reviewKindEnum.enumValues).optional().catch(undefined),
  before: z.uuid().optional().catch(undefined),
});
const time = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function Page({ searchParams }: PageProps<"/review">) {
  await requireAdmin();
  const { kind, before } = querySchema.parse(await searchParams);
  const db = getDb();
  const [counts, tasks] = await Promise.all([reviewCounts(db), listOpenTasks(db, { kind, limit: PAGE_SIZE, before })]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const filter = (k?: string) => (k ? `/review?kind=${k}` : "/review");
  const more =
    tasks.length === PAGE_SIZE
      ? `/review?${new URLSearchParams({ ...(kind ? { kind } : {}), before: tasks.at(-1)!.id })}`
      : null;

  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold">Prüfen</h1>
      <ul aria-label="Offene Aufgaben je Art" className="flex flex-wrap gap-x-4 gap-y-1">
        <li>
          <Link href={filter()} className={kind ? "hover:underline" : "font-semibold"}>
            Alle: {total}
          </Link>
        </li>
        {reviewKindEnum.enumValues.map((k) => (
          <li key={k}>
            <Link href={filter(k)} className={kind === k ? "font-semibold" : "hover:underline"}>
              {REVIEW_KIND_LABELS[k]}: <span data-testid={`count-${k}`}>{counts[k]}</span>
            </Link>
          </li>
        ))}
      </ul>

      {tasks.length === 0 ? (
        <p>Keine offenen Aufgaben.</p>
      ) : (
        <>
          <p>
            <Link href={`/review/${tasks[0]!.id}`} className="underline">
              Erste Aufgabe bearbeiten
            </Link>
          </p>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-1 pr-4">Art</th>
                <th className="pr-4">Gegenstand</th>
                <th className="pr-4">Priorität</th>
                <th>Erstellt</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} className="border-b border-neutral-200">
                  <td className="py-1 pr-4">{REVIEW_KIND_LABELS[t.kind]}</td>
                  <td className="pr-4">
                    <Link href={`/review/${t.id}`} className="underline">
                      {t.name ?? t.subjectId}
                    </Link>
                  </td>
                  <td className="pr-4">{t.priority}</td>
                  <td className="whitespace-nowrap">{time(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {more && (
            <p>
              <Link href={more} className="underline">
                Weitere
              </Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
