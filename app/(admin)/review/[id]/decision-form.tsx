import type { ReactNode } from "react";
import type { ReviewDecision } from "@/lib/domain/review-decisions";
import { buttonClass, cx } from "../../_components/ui";
import { decideAction } from "./actions";
import { Kbd } from "./parts";

/**
 * One decision of a review task: a form for `decideAction` (or `action`), reachable with key `n` (see
 * DecisionKeys). The decision is `decision` as JSON, or a field named `decision` among `children` (e.g. a select
 * of choices); another `action` reads its own fields from `children`. `taskKey` is the context key of a profile task as
 * shown (the decision is refused when the task changed meanwhile, ruling M5-F-R2); `valueKey` is the fingerprint of the
 * value a conflict decision chose (refused when that side holds another value by now, ruling M5-G-R2). `hint` says in
 * one sentence what the decision does; `variant` styles its button.
 */
export function DecisionForm({
  action = decideAction,
  n,
  taskId,
  openedAt,
  label,
  decision,
  taskKey,
  valueKey,
  disabled = false,
  variant = "secondary",
  hint,
  children,
}: {
  action?: (formData: FormData) => Promise<void>;
  n: number;
  taskId: string;
  openedAt: string;
  label: string;
  decision?: ReviewDecision;
  taskKey?: string;
  valueKey?: string;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <form action={action} data-decision-key={n} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="openedAt" value={openedAt} />
      {decision && <input type="hidden" name="decision" value={JSON.stringify(decision)} />}
      {valueKey !== undefined && <input type="hidden" name="valueKey" value={valueKey} />}
      {taskKey !== undefined && <input type="hidden" name="taskKey" value={taskKey} />}
      <span className="inline-flex items-center gap-2">
        <button
          type="submit"
          disabled={disabled}
          aria-keyshortcuts={String(n)}
          className={cx(buttonClass(variant), "min-w-32")}
        >
          {label}
        </button>
        <Kbd title={`Taste ${n}`}>{n}</Kbd>
      </span>
      {children}
      {hint && <p className="w-full text-xs leading-snug text-muted text-pretty">{hint}</p>}
    </form>
  );
}
