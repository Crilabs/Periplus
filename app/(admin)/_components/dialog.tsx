"use client";

import { useRef, type ReactNode } from "react";
import { buttonClass, cx } from "./ui";

/**
 * A button that opens a modal with details or a form. Built on the native <dialog>: focus trap,
 * Escape and the backdrop come from the browser. Server components (and server-action forms) can be
 * passed as children. Submitting a form inside closes the dialog, so a redirect back to the same page
 * shows its result notice instead of a stale modal.
 */
export function Dialog({
  trigger,
  triggerVariant = "secondary",
  triggerSize = "md",
  triggerClassName,
  title,
  description,
  children,
  wide = false,
}: {
  trigger: ReactNode;
  triggerVariant?: "primary" | "secondary" | "ghost" | "danger";
  triggerSize?: "sm" | "md";
  triggerClassName?: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        className={cx(buttonClass(triggerVariant, triggerSize), triggerClassName)}
        onClick={() => ref.current?.showModal()}
      >
        {trigger}
      </button>
      <dialog
        ref={ref}
        onSubmit={() => ref.current?.close()}
        onClick={(e) => {
          // A click on the backdrop lands on the <dialog> element itself.
          if (e.target === ref.current) ref.current.close();
        }}
        className={cx(
          "m-auto max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto rounded-xl border border-line bg-surface p-0 text-ink shadow-2xl",
          wide ? "max-w-4xl" : "max-w-lg",
        )}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-surface px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>}
          </div>
          <button
            type="button"
            aria-label="Schließen"
            onClick={() => ref.current?.close()}
            className="-mr-1 rounded-md p-1 text-muted hover:bg-sunken hover:text-ink"
          >
            <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4 text-sm">{children}</div>
      </dialog>
    </>
  );
}
