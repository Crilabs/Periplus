"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const MESSAGES = {
  invalid: "E-Mail oder Passwort falsch.",
  rate_limited: "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.",
} as const;

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, { error: null });
  return (
    <form action={action} className="flex w-full max-w-sm flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1 text-sm">
        E-Mail
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className="rounded border border-neutral-400 bg-transparent px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Passwort
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded border border-neutral-400 bg-transparent px-3 py-2"
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {MESSAGES[state.error]}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
      >
        Anmelden
      </button>
    </form>
  );
}
