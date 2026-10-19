import type { ReactNode } from "react";
import { cx, Panel } from "../../_components/ui";

/** A keyboard key, e.g. the shortcut of a decision. */
export function Kbd({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <kbd
      title={title}
      className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-sunken px-1 font-mono text-[11px] leading-none text-muted shadow-[inset_0_-1px_0_var(--color-line-strong)]"
    >
      {children}
    </kbd>
  );
}

/**
 * The decision block on top of a task: the question in the description, one DecisionForm per row, an optional
 * note on what the decisions do, and the keyboard shortcuts.
 */
export function DecisionPanel({
  question,
  children,
  note,
  className,
}: {
  question: ReactNode;
  children: ReactNode;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <Panel title="Entscheidung" description={question} className={cx("border-accent/40 shadow-sm", className)}>
      <div className="divide-y divide-line">{children}</div>
      {note && <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted text-pretty">{note}</p>}
      <p className="mt-3 text-xs text-muted">
        Tasten <Kbd>1</Kbd>–<Kbd>4</Kbd> lösen die Entscheidung mit dieser Nummer aus, <Kbd>n</Kbd> öffnet die nächste
        Aufgabe; in Eingabefeldern sind sie aus.
      </p>
    </Panel>
  );
}

type LegendRole = "subject" | "nearby" | "picked" | "hit" | "object";

const LEGEND_DOT: Record<LegendRole, string> = {
  subject: "bg-danger",
  nearby: "bg-accent",
  picked: "bg-ok",
  hit: "bg-warn",
  object: "bg-muted",
};

/** Colour key below a MiniMap (the map's own colours: subject red, nearby blue, picked green, hits amber). */
export function MapLegend({ items }: { items: Array<[LegendRole, string]> }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map(([role, label]) => (
        <li key={role} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cx("size-2.5 rounded-full ring-2 ring-surface", LEGEND_DOT[role])} />
          {label}
        </li>
      ))}
    </ul>
  );
}

/** A collapsible block for long or rarely needed evidence. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group rounded-md border border-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium select-none hover:bg-sunken/50 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-muted transition-transform group-open:rotate-90">
          ›
        </span>
        {summary}
      </summary>
      <div className="border-t border-line px-3 py-3">{children}</div>
    </details>
  );
}
