import type { StageDefinition } from "@/lib/pipeline/runs";
import { pingStage } from "./handlers/system-ping";

/** Every stage a run may name, by stage name. Kept apart from HANDLERS so pipeline code can import it without a cycle. */
export const STAGES: Record<string, StageDefinition> = {
  [pingStage.name]: pingStage,
};
