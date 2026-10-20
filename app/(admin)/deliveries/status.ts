import type { DeliveryStatus } from "@/lib/db/schema";
import type { Tone } from "../_components/ui";

/** Colour of a package status: valid green, rejected red, unchanged grey. */
export const DELIVERY_STATUS_TONES: Record<DeliveryStatus, Tone> = { valid: "ok", rejected: "danger", unchanged: "neutral" };
