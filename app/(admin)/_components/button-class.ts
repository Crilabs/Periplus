/*
 * Class names of the admin's buttons, shared by the server-safe building blocks (ui.tsx) and the client components
 * (Button with its pending state, Dialog).
 */

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export type Variant = "primary" | "secondary" | "ghost" | "danger";
export type Size = "sm" | "md";

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
