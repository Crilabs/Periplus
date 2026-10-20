// No import of ./runs here: the job handler imports this module, which must not reach the stage registry (import
// cycle, ruling M6-P17); the starter lives in ./delivery-run.

/** Stage of the run "Paket bauen": one job builds the package of `run.params.areaId` (spec 08). */
export const DELIVERY_STAGE = "delivery.build";

/** The area geo object id of a delivery run's params; throws when it is missing. */
export function deliveryAreaId(params: Record<string, unknown>): string {
  const areaId = params.areaId;
  if (typeof areaId !== "string" || areaId === "") throw new Error("areaId is required");
  return areaId;
}
