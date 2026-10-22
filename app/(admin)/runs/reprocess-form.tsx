"use client";

import { useEffect, useState } from "react";
import type { ReprocessEstimate } from "@/lib/domain/extraction/reprocess-estimate";
import type { SubdivisionOption } from "@/lib/domain/subdivisions/store";
import { SubdivisionOptions } from "../_components/subdivision-options";
import { Button, cx, fmt, inputClass } from "../_components/ui";
import { reprocessEstimateAction } from "./actions";

type State = { key: string; result: { ok: true; estimate: ReprocessEstimate } | { ok: false } } | null;

/** The start form of „Reprozessieren“: the estimate of the chosen subdivision is fetched when it is chosen (spec 17 „Einführung“). */
export function ReprocessForm({
  options,
  action,
  button,
}: {
  options: SubdivisionOption[];
  action: (input: FormData) => Promise<void>;
  button: string;
}) {
  const [key, setKey] = useState(options[0]?.key ?? "");
  const [state, setState] = useState<State>(null);
  useEffect(() => {
    if (!key) return;
    let current = true;
    reprocessEstimateAction(key)
      .then((result) => current && setState({ key, result }))
      .catch(() => current && setState({ key, result: { ok: false } }));
    return () => {
      current = false;
    };
  }, [key]);
  const shown = state?.key === key ? state.result : null;
  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor="reprocess-scope" className="sr-only">
          Landesteil
        </label>
        <select id="reprocess-scope" name="subdivisionKey" required value={key} onChange={(e) => setKey(e.target.value)} className={cx(inputClass, "min-w-40")}>
          <SubdivisionOptions options={options} />
        </select>
        <Button type="submit" variant="primary">
          {button}
        </Button>
      </div>
      <p className="max-w-80 text-right text-xs text-muted" data-testid="reprocess-estimate" aria-live="polite">
        {shown === null
          ? "Schätzung wird berechnet …"
          : !shown.ok
            ? "Schätzung nicht möglich"
            : shown.estimate.estimateEur === null
              ? `${fmt.int(shown.estimate.mentions)} Erwähnungen, keine Schätzung (noch kein Extraktionslauf mit Kosten)`
              : `${fmt.int(shown.estimate.mentions)} Erwähnungen, Schätzung etwa ${fmt.eur(shown.estimate.estimateEur)} (Extraktion, ${fmt.eur(shown.estimate.costPerMentionEur!, 4)} je Erwähnung; ohne Folgesuche und Bilder)`}
      </p>
    </form>
  );
}
