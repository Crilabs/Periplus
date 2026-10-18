"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));

/**
 * Keyboard shortcuts of a review task: `1`–`4` submit the decision form marked `data-decision-key="<n>"`,
 * `n` opens `nextHref`. Inactive while an input field has focus.
 */
export function DecisionKeys({ nextHref }: { nextHref: string }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      if (e.key === "n") {
        e.preventDefault();
        router.push(nextHref);
        return;
      }
      if (!["1", "2", "3", "4"].includes(e.key)) return;
      const form = document.querySelector<HTMLFormElement>(`form[data-decision-key="${e.key}"]`);
      const submit = form?.querySelector<HTMLButtonElement>("button[type=submit]");
      if (!form || submit?.disabled) return;
      e.preventDefault();
      form.requestSubmit(submit ?? undefined);
    };
    document.addEventListener("keydown", onKey);
    // Marks the shortcuts as active (e.g. for end-to-end tests, which must not press keys before hydration).
    document.body.dataset.decisionKeys = "on";
    return () => {
      document.removeEventListener("keydown", onKey);
      delete document.body.dataset.decisionKeys;
    };
  }, [router, nextHref]);
  return null;
}
