import type { PlaceStatus } from "@/lib/db/schema/geo";
import { restrictedKindEnum } from "@/lib/db/schema/geo";

/*
 * The `exclude` identity value of a place in the vocabulary of the delivery contract (spec 08, datendienst-spec
 * "exclude"): `{ excluded, reason, detail }`, `reason` a camelCase enum and required when `excluded` (ruling M5-E-R3).
 */

/** The contract's exclusion reasons. */
export type ExcludeReason =
  | "anchoringProhibited"
  | "military"
  | "cable"
  | "protectedArea"
  | "ferryLane"
  | "unsafe"
  | "aquaculture";

export type ExcludeValue = { excluded: boolean; reason: ExcludeReason | null; detail: string | null };

type RestrictedKind = (typeof restrictedKindEnum.enumValues)[number];

/** Restricted-area kind → contract reason; a firing area is a military exclusion. */
const REASON_BY_KIND: Record<RestrictedKind, ExcludeReason> = {
  military: "military",
  cable: "cable",
  protected_area: "protectedArea",
  aquaculture: "aquaculture",
  ferry_lane: "ferryLane",
  firing_area: "military",
};

/** The restricted area behind a `status_reason` `restricted:<kind>:<id>` (`exclusionReason`), else null. */
export function restrictionOf(statusReason: string | null): { kind: RestrictedKind; restrictedAreaId: string } | null {
  const m = /^restricted:([a-z_]+):(.+)$/.exec(statusReason ?? "");
  if (!m || !(restrictedKindEnum.enumValues as readonly string[]).includes(m[1]!)) return null;
  return { kind: m[1] as RestrictedKind, restrictedAreaId: m[2]! };
}

/**
 * `excluded` = status `no_anchoring`. The reason comes from the restricted area that excluded the place; any other
 * exclusion (an admin's review decision, an unknown or missing reason) is `anchoringProhibited`, so an excluded place
 * always has a reason. Not excluded → reason null. `detail` stays null (internal reasons and ids are no display text).
 */
export function excludeValue(status: PlaceStatus, statusReason: string | null): ExcludeValue {
  if (status !== "no_anchoring") return { excluded: false, reason: null, detail: null };
  const restriction = restrictionOf(statusReason);
  return { excluded: true, reason: restriction ? REASON_BY_KIND[restriction.kind] : "anchoringProhibited", detail: null };
}
