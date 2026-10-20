"use client";

import { useActionState } from "react";
import { Button, Field, inputClass, Notice } from "../(admin)/_components/ui";
import { login, type LoginState } from "./actions";

const MESSAGES = {
  invalid: "E-Mail oder Passwort falsch.",
  rate_limited: "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.",
} as const;

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, { error: null });
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <Field label="E-Mail">
        <input name="email" type="email" autoComplete="username" required className={inputClass} />
      </Field>
      <Field label="Passwort">
        <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </Field>
      {state.error && <Notice tone="danger">{MESSAGES[state.error]}</Notice>}
      <Button type="submit" variant="primary" disabled={pending} className="mt-1 w-full">
        Anmelden
      </Button>
    </form>
  );
}
