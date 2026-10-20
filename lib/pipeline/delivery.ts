// No import of ./runs here: the job handler imports this module, which must not reach the stage registry (import
// cycle, ruling M6-P17); the starter lives in ./delivery-run.

/** Stage of the run "Paket bauen": one job builds the package of `run.params.subdivisionId` (spec 08, spec 14). */
export const DELIVERY_STAGE = "delivery.build";

/** The subdivision id of a delivery run's params; throws when it is missing. */
export function deliverySubdivisionId(params: Record<string, unknown>): string {
  const subdivisionId = params.subdivisionId;
  if (typeof subdivisionId !== "string" || subdivisionId === "") throw new Error("subdivisionId is required");
  return subdivisionId;
}
