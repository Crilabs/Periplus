"use client";

import { Button, ButtonLink, Mono, Notice, PageHeader } from "./_components/ui";

/**
 * The admin's error boundary (gesamt review UI-7): a page or an action that throws shows this inside the admin layout,
 * in German, with the navigation kept. Whether an action that threw had already stored something is unknown here (the
 * actions report their known outcomes as notices themselves), so the page says to look before repeating it.
 */
export default function AdminError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  return (
    <>
      <PageHeader title="Fehler" description="Die Seite oder die eben ausgelöste Aktion ist mit einem unerwarteten Fehler abgebrochen." />
      <Notice
        tone="danger"
        title="Unerwarteter Fehler"
        actions={
          <>
            <Button type="button" variant="primary" onClick={() => retry()}>
              Erneut versuchen
            </Button>
            <Button type="button" onClick={() => window.location.reload()}>
              Seite neu laden
            </Button>
            <ButtonLink href="/">Zur Übersicht</ButtonLink>
          </>
        }
      >
        Ob eine eben ausgelöste Änderung schon gespeichert wurde, lässt sich hier nicht sagen: vor einer Wiederholung auf der
        Seite nachsehen, ob sie übernommen wurde.
        {digest && (
          <>
            {" "}
            Fehler-Kennung für das Log: <Mono>{digest}</Mono>
          </>
        )}
      </Notice>
    </>
  );
}
