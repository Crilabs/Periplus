"use client";

import { useState, useTransition } from "react";
import { Button } from "../_components/button";
import { cx } from "../_components/button-class";
import { createMcpTokenAction } from "./mcp-actions";

const inputClass =
  "h-9 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-muted/70 " +
  "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60";

/** The `claude mcp add` command for a token: user scope, never project scope (a token in `.mcp.json` lands in the repo). */
export function mcpAddCommand(mcpUrl: string, token: string): string {
  return `claude mcp add --transport http --scope user periplus ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-sunken px-2.5 py-2 font-mono text-xs">{value}</code>
        <Button
          type="button"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? "Kopiert" : "Kopieren"}
        </Button>
      </div>
    </div>
  );
}

/** „Token anlegen“: name and validity; the token and the setup command are shown once. */
export function McpTokenForm({ mcpUrl }: { mcpUrl: string }) {
  const [name, setName] = useState("");
  const [validityDays, setValidityDays] = useState(90);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; expiresAt: string } | null>(null);
  const [pending, start] = useTransition();

  if (created) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm font-medium">
          Nur jetzt sichtbar. Periplus speichert das Token nicht und kann es nicht noch einmal zeigen. Gültig bis{" "}
          {new Date(created.expiresAt).toLocaleDateString("de-DE")}.
        </p>
        <CopyField label="Token" value={created.token} />
        <CopyField label="Einrichtung in Claude Code (Terminal)" value={mcpAddCommand(mcpUrl, created.token)} />
        <p className="text-xs leading-snug text-muted">
          Immer mit <code>--scope user</code>, nie <code>--scope project</code>: sonst steht das Token in <code>.mcp.json</code> und landet im Repo.
          Danach in Claude Code <code>/mcp</code> aufrufen und prüfen, dass „periplus“ verbunden ist.
        </p>
        <div>
          <Button type="button" size="sm" onClick={() => setCreated(null)}>
            Fertig
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await createMcpTokenAction({ name, validityDays });
          if (res.ok) {
            setCreated({ token: res.token, expiresAt: res.expiresAt });
            setName("");
          } else setError(res.error);
        });
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Name</span>
        <input className={cx(inputClass, "w-64")} value={name} maxLength={60} placeholder="z. B. Laptop" onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Gültigkeit</span>
        <select className={inputClass} value={validityDays} onChange={(e) => setValidityDays(Number(e.target.value))}>
          <option value={30}>30 Tage</option>
          <option value={90}>90 Tage</option>
          <option value={365}>365 Tage</option>
        </select>
      </label>
      <Button variant="primary" disabled={pending}>
        Token anlegen
      </Button>
      {error && <p className="w-full text-sm text-danger">{error}</p>}
    </form>
  );
}
