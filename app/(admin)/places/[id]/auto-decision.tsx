import type { AutoDecision } from "@/lib/domain/geo-view";
import { AUTO_RULE_LABELS } from "../../_components/labels";
import { fmt, TextLink } from "../../_components/ui";

const TEXT: Record<AutoDecision["action"], string> = {
  confirm: "Automatisch bestätigt am",
  no_anchoring: "Automatisch als Ankerverbot eingestuft am",
  candidate: "Bestätigung automatisch zurückgenommen am",
  set_kind: "Ortsart automatisch geändert am",
};

/** „Automatisch bestätigt am <Datum> (Regel: <Label>)“ with links to the documents the decision rests on. */
export function AutoDecisionLine({ decision }: { decision: AutoDecision }) {
  const rule = decision.rule ? (AUTO_RULE_LABELS[decision.rule] ?? decision.rule) : null;
  return (
    <span data-testid="auto-decision">
      {`${TEXT[decision.action]} ${fmt.date(decision.decidedAt)}`}
      {rule && ` (Regel: ${rule})`}
      {decision.documentIds.length > 0 && (
        <span className="mt-1 block text-xs">
          Belege:{" "}
          {decision.documentIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <TextLink href={`/documents/${id}`}>Dokument {i + 1}</TextLink>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
