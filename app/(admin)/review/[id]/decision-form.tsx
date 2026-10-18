import type { ReactNode } from "react";
import type { ReviewDecision } from "@/lib/domain/review-decisions";
import { decideAction } from "./actions";

/**
 * One decision of a review task: a form for `decideAction`, reachable with key `n` (see DecisionKeys). The
 * decision is `decision` as JSON, or a field named `decision` among `children` (e.g. a select of choices).
 */
export function DecisionForm({
  n,
  taskId,
  openedAt,
  label,
  decision,
  disabled = false,
  children,
}: {
  n: number;
  taskId: string;
  openedAt: string;
  label: string;
  decision?: ReviewDecision;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <form action={decideAction} data-decision-key={n} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="openedAt" value={openedAt} />
      {decision && <input type="hidden" name="decision" value={JSON.stringify(decision)} />}
      <button
        type="submit"
        disabled={disabled}
        aria-keyshortcuts={String(n)}
        className="rounded border border-neutral-400 px-3 py-1 hover:bg-neutral-100 disabled:opacity-50"
      >
        {label}
      </button>
      <kbd className="rounded border border-neutral-300 px-1 text-xs text-neutral-500">{n}</kbd>
      {children}
    </form>
  );
}
