import type { PlaceStatus } from "@/lib/db/schema";
import { adminStatusChoices, type AdminPlaceStatus } from "@/lib/domain/place-status";
import { Dialog } from "../../_components/dialog";
import { Button } from "../../_components/ui";
import { setPlaceStatusAction } from "./actions";

const STATUS_ACTIONS: Record<AdminPlaceStatus, { label: string; effect: string }> = {
  confirmed: { label: "Bestätigen", effect: "Der Ort wird bestätigt und mit dem nächsten Paket seines Reviers als Ankerplatz geliefert." },
  rejected: { label: "Verwerfen", effect: "Der Ort wird verworfen; das nächste Paket seines Reviers meldet ihn als entfernt." },
  no_anchoring: {
    label: "Kein Ankerplatz",
    effect: "Das nächste Paket seines Reviers liefert den Ort als ausgeschlossen: Ankern ist hier nicht möglich oder nicht erlaubt.",
  },
};

/** The effect of a withdrawal on a place that is not confirmed (it was never delivered as a spot, or no longer is). */
const UNCONFIRMED_EFFECTS: Record<Exclude<AdminPlaceStatus, "confirmed">, string> = {
  rejected: "Der Ort wird verworfen und nicht als Ankerplatz geführt.",
  no_anchoring: "Der Ort wird als „Kein Ankerplatz“ gespeichert: Ankern ist hier nicht möglich oder nicht erlaubt.",
};

/**
 * „Bestätigen“ / „Verwerfen“ / „Kein Ankerplatz“ in the place header (spec 09, gesamt review UI-3); only without an
 * open review task of the place, which decides with its context. Each form posts the status the page shows (`from`), so
 * a stale tab is refused when the status changed meanwhile (W4-2). „Verwerfen“ and „Kein Ankerplatz“ ask first, in a
 * dialog; for a confirmed place it names the effect on the next package.
 */
export function StatusActions({ placeId, status }: { placeId: string; status: PlaceStatus }) {
  return adminStatusChoices(status).map((s) => {
    const form = (
      <form action={setPlaceStatusAction} className={s !== "confirmed" ? "flex justify-end" : undefined}>
        <input type="hidden" name="placeId" value={placeId} />
        <input type="hidden" name="status" value={s} />
        <input type="hidden" name="from" value={status} />
        <Button variant={s === "confirmed" ? "primary" : "danger"}>{STATUS_ACTIONS[s].label}</Button>
      </form>
    );
    if (s === "confirmed") return <span key={s}>{form}</span>;
    const effect = status === "confirmed" ? STATUS_ACTIONS[s].effect : UNCONFIRMED_EFFECTS[s];
    return (
      <Dialog
        key={s}
        trigger={`${STATUS_ACTIONS[s].label} …`}
        triggerVariant={status === "confirmed" ? "danger" : "secondary"}
        title={STATUS_ACTIONS[s].label}
        description={`${effect} Das Profil wird danach neu berechnet.`}
      >
        {form}
      </Dialog>
    );
  });
}
