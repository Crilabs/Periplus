import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/*
 * The admin's building blocks. Pages compose these instead of styling raw elements, so spacing,
 * colour and wording patterns stay the same everywhere. Server-safe: no hooks, no client code.
 */

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------------------------------------
// Buttons and form controls

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110 border border-transparent",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-sunken",
  ghost: "text-accent border border-transparent hover:bg-accent-soft",
  danger: "bg-surface text-danger border border-danger/40 hover:bg-danger-soft",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export function buttonClass(variant: Variant = "secondary", size: Size = "md") {
  return cx(
    "inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors",
    "disabled:cursor-not-allowed disabled:opacity-50",
    VARIANTS[variant],
    SIZES[size],
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "submit",
  ...rest
}: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={cx(buttonClass(variant, size), className)} {...rest} />;
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={cx(buttonClass(variant, size), className)} {...rest} />;
}

/** Text inputs, selects and textareas. */
export const inputClass =
  "h-9 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-muted/70 " +
  "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60";

export const textareaClass = cx(inputClass, "h-auto min-h-24 py-2 leading-relaxed");

/** A labelled control with an optional explanation underneath. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("flex flex-col gap-1.5 text-sm", className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs leading-snug text-muted">{hint}</span>}
    </label>
  );
}

/** Plain text link in the accent colour. */
export function TextLink({ className, ...rest }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cx("text-accent underline-offset-2 hover:underline", className)}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Page structure

/**
 * Title row of every page. `description` says in one or two sentences what the page is for;
 * `back` points to the parent list on detail pages; `actions` holds the page's main buttons.
 */
export function PageHeader({
  title,
  description,
  back,
  meta,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  back?: { href: string; label: string };
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-3xl">
        {back && (
          <Link href={back.href} className="mb-1.5 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
            <span aria-hidden>‹</span> {back.label}
          </Link>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {meta && <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted">{meta}</div>}
        {description && <p className="mt-1.5 text-sm leading-relaxed text-muted text-pretty">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled block of content on a surface. Use `flush` when the body is a table that should reach the edges. */
export function Panel({
  title,
  description,
  actions,
  children,
  flush = false,
  className,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cx("rounded-lg border border-line bg-surface", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs leading-snug text-muted text-pretty">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

/** Key/value list for the facts about one object (detail pages, dialogs). */
export function DescriptionList({
  items,
  columns = 2,
}: {
  items: Array<{ label: ReactNode; value: ReactNode; hint?: string } | null | undefined | false | "" | 0>;
  columns?: 1 | 2 | 3;
}) {
  const cols = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3" }[columns];
  return (
    <dl className={cx("grid gap-x-8 gap-y-3 text-sm", cols)}>
      {items.filter(Boolean).map((item, i) => {
        const { label, value, hint } = item as { label: ReactNode; value: ReactNode; hint?: string };
        return (
          <div key={i} className="min-w-0">
            <dt className="text-xs text-muted" title={hint}>
              {label}
            </dt>
            <dd className="mt-0.5 break-words">{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

// ---------------------------------------------------------------------------------------------
// Status and numbers

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-sunken text-muted ring-line",
  accent: "bg-accent-soft text-accent ring-accent/25",
  ok: "bg-ok-soft text-ok ring-ok/25",
  warn: "bg-warn-soft text-warn ring-warn/25",
  danger: "bg-danger-soft text-danger ring-danger/25",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

/** A small coloured dot before a status word. */
export function StatusDot({ tone = "neutral", pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const colour = { neutral: "bg-muted", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger" }[tone];
  return (
    <span className="relative inline-flex size-2 shrink-0" aria-hidden>
      {pulse && <span className={cx("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", colour)} />}
      <span className={cx("relative inline-flex size-2 rounded-full", colour)} />
    </span>
  );
}

/** One key figure: a number with a label, optionally linked and with a short explanation. */
export function Stat({
  label,
  value,
  hint,
  href,
  tone = "neutral",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: Tone;
}) {
  const valueTone = { neutral: "", accent: "text-accent", ok: "text-ok", warn: "text-warn", danger: "text-danger" }[tone];
  const body = (
    <>
      <span className="text-xs text-muted">{label}</span>
      <span className={cx("mt-1 text-2xl font-semibold tabular-nums tracking-tight", valueTone)}>{value}</span>
      {hint && <span className="mt-1 text-xs leading-snug text-muted">{hint}</span>}
    </>
  );
  const cls = "flex flex-col rounded-lg border border-line bg-surface px-4 py-3";
  return href ? (
    <Link href={href} className={cx(cls, "transition-colors hover:border-accent/50")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** A horizontal meter, e.g. budget used. `ratio` is 0..1 (values above 1 are shown full and red). */
export function Meter({ ratio, label }: { ratio: number; label: string }) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  const tone = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warn" : "bg-accent";
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"
    >
      <div className={cx("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Messages

/**
 * Inline message. `tone="danger"` gets role="alert", everything else role="status".
 * Keep the text actionable: what happened, and what to do next.
 */
export function Notice({
  tone = "accent",
  title,
  children,
  actions,
  className,
  ...rest
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
} & Omit<ComponentProps<"div">, "title">) {
  const frame = {
    neutral: "border-line bg-sunken",
    accent: "border-accent/30 bg-accent-soft",
    ok: "border-ok/30 bg-ok-soft",
    warn: "border-warn/30 bg-warn-soft",
    danger: "border-danger/30 bg-danger-soft",
  }[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx("flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm", frame, className)}
      {...rest}
    >
      <div className="min-w-0 space-y-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="leading-relaxed text-pretty">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** What an empty list says: what would be here, and how to get it there. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm leading-relaxed text-muted text-pretty">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tables

/** Wrapper for data tables: scrolls horizontally on narrow screens. Put inside a flush Panel. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx("w-full border-collapse text-left text-sm", className)}>{children}</table>
    </div>
  );
}

export const thClass =
  "border-b border-line bg-sunken/60 px-4 py-2 text-xs font-medium whitespace-nowrap text-muted first:rounded-tl-lg last:rounded-tr-lg";
export const tdClass = "border-b border-line px-4 py-2.5 align-top";
export const trClass = "transition-colors hover:bg-sunken/50 [&:last-child>td]:border-b-0";
/** Numeric cells: right-aligned, tabular figures. */
export const numClass = "text-right tabular-nums whitespace-nowrap";

/** Short, copyable technical identifier (run id, hash, queue name). */
export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className="font-mono text-[0.8125rem] text-muted">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Navigation inside a page

/** Segment tabs as links (`?tab=`). The accessible name defaults to "Reiter", which tests rely on. */
export function TabNav({
  items,
  label = "Reiter",
}: {
  items: Array<{ href: string; label: ReactNode; current: boolean; count?: number }>;
  label?: string;
}) {
  return (
    <nav aria-label={label} className="mb-6 border-b border-line">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              className={cx(
                "inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
                item.current
                  ? "border-accent font-medium text-ink"
                  : "border-transparent text-muted hover:border-line-strong hover:text-ink",
              )}
            >
              {item.label}
              {item.count !== undefined && (
                <span className="rounded-full bg-sunken px-1.5 text-xs tabular-nums text-muted">{item.count}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Filter chips, e.g. status counts that filter a list. */
export function FilterChips({
  items,
  label,
}: {
  items: Array<{ href: string; label: ReactNode; count?: number; current: boolean }>;
  label: string;
}) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            aria-current={item.current ? "true" : undefined}
            className={cx(
              "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm transition-colors",
              item.current
                ? "border-accent bg-accent-soft font-medium text-accent"
                : "border-line bg-surface text-ink hover:border-line-strong",
            )}
          >
            {item.label}
            {item.count !== undefined && <span className="tabular-nums text-muted">{item.count}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Previous / next links with "Seite x von y". */
export function Pagination({
  page,
  pages,
  total,
  noun,
  href,
}: {
  page: number;
  pages: number;
  total: number;
  noun: string;
  href: (page: number) => string;
}) {
  return (
    <nav aria-label="Seiten" className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-muted">
      <span>
        Seite {page} von {pages} ({total.toLocaleString("de-DE")} {noun})
      </span>
      <span className="flex gap-2">
        {page > 1 && (
          <ButtonLink href={href(page - 1)} size="sm">
            Zurück
          </ButtonLink>
        )}
        {page < pages && (
          <ButtonLink href={href(page + 1)} size="sm">
            Weiter
          </ButtonLink>
        )}
      </span>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
// Formatting shared across pages

export const fmt = {
  eur: (n: number, digits = 2) =>
    n.toLocaleString("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: digits, maximumFractionDigits: digits }),
  int: (n: number) => n.toLocaleString("de-DE"),
  pct: (ratio: number) => `${Math.round(ratio * 100)} %`,
  /** "20.10.2026, 14:03" in Europe/Berlin. */
  dateTime: (d: Date | null | undefined) =>
    d
      ? d.toLocaleString("de-DE", {
          timeZone: "Europe/Berlin",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "–",
  date: (d: Date | null | undefined) =>
    d ? d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }) : "–",
  /** "vor 3 Min." style, relative to `now`. */
  ago: (d: Date | null | undefined, now: Date = new Date()) => {
    if (!d) return "–";
    const s = Math.round((now.getTime() - d.getTime()) / 1000);
    if (s < 60) return "gerade eben";
    if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
    if (s < 86_400) return `vor ${Math.round(s / 3600)} Std.`;
    return `vor ${Math.round(s / 86_400)} Tagen`;
  },
  /** Seconds as "12 s", "4 Min.", "2 Std.". */
  duration: (seconds: number) =>
    seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${Math.round(seconds / 60)} Min.` : `${Math.round(seconds / 3600)} Std.`,
};
