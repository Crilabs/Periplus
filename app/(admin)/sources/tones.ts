import type { SourceStatus } from "@/lib/db/schema";
import type { Tone } from "../_components/ui";

/** Badge tone of a source status. */
export const SOURCE_STATUS_TONES: Record<SourceStatus, Tone> = {
  proposed: "warn",
  approved: "ok",
  rejected: "danger",
  paused: "neutral",
};
