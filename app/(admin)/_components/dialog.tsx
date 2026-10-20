"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { buttonClass, cx } from "./button-class";

/**
 * A button that opens a modal with details or a form. Built on the native <dialog>: focus trap,
 * Escape and the backdrop come from the browser. Server components (and server-action forms) can be
 * passed as children. Submitting a form inside closes the dialog, so a redirect back to the same page
 * shows its result notice instead of a stale modal. The title names the dialog for screen readers.
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
      <DialogPanel dialogRef={ref} title={title} description={description} wide={wide} closeOnSubmit>
        {children}
      </DialogPanel>
    </>
  );
}

/** The modal itself: header with title, description and close button, then the body. */
function DialogPanel({
  dialogRef,
  title,
  description,
  children,
  wide = false,
  closeOnSubmit = false,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  closeOnSubmit?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onSubmit={closeOnSubmit ? () => dialogRef.current?.close() : undefined}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (e.target === dialogRef.current) dialogRef.current.close();
      }}
      className={cx(
        "m-auto max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto rounded-xl border border-line bg-surface p-0 text-ink shadow-2xl",
        wide ? "max-w-4xl" : "max-w-lg",
      )}
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-surface px-5 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-muted">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Schließen"
          onClick={() => dialogRef.current?.close()}
          className="-mr-1 rounded-md p-1 text-muted hover:bg-sunken hover:text-ink"
        >
          <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="px-5 py-4 text-sm">{children}</div>
    </dialog>
  );
}

/**
 * Asks before the enclosing form submits, however it is submitted (its button or a decision key): the first submit
 * opens a modal; only its confirm button submits the form. For a decision that cannot be taken back (gesamt review
 * UI-2). Place it inside the form.
 */
export function ConfirmOnSubmit({
  title,
  description,
  confirmLabel,
}: {
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const submitter = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    // A listener on the form runs before React's delegated one, which then leaves a prevented submit alone.
    const onSubmit = (e: SubmitEvent) => {
      if (confirmed.current) return;
      e.preventDefault();
      submitter.current = e.submitter;
      ref.current?.showModal();
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, []);
  return (
    <DialogPanel dialogRef={ref} title={title} description={description}>
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass("secondary")} onClick={() => ref.current?.close()}>
          Abbrechen
        </button>
        <button
          type="button"
          className={buttonClass("danger")}
          onClick={() => {
            confirmed.current = true;
            ref.current?.close();
            ref.current?.closest("form")?.requestSubmit(submitter.current instanceof HTMLButtonElement ? submitter.current : undefined);
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </DialogPanel>
  );
}
