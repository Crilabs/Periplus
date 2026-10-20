// No import of ./runs here: the job handler and the domain read this module, which must not reach the stage registry
// (import cycle, rulings M6-P17, M7-P5); the starter lives in ./quality-run.

/** Stage of a measurement run: one job computes the quality snapshot of `run.params.subdivisionKey` (spec 10). */
export const QUALITY_MEASURE_STAGE = "quality.measure";

/** A measurement run's params: subdivision, label and window (`from` inclusive, `to` exclusive, ISO timestamps). */
export type MeasurementParams = { subdivisionKey: string; label: string; from: Date; to: Date };

/** The params of a measurement run; throws when one is missing or not a valid date. */
export function measurementParams(params: Record<string, unknown>): MeasurementParams {
  const { subdivisionKey, label, from, to } = params;
  if (typeof subdivisionKey !== "string" || subdivisionKey === "") throw new Error("subdivisionKey is required");
  if (typeof label !== "string" || label === "") throw new Error("label is required");
  const dates = [from, to].map((d) => (typeof d === "string" ? new Date(d) : null));
  if (dates.some((d) => d === null || Number.isNaN(d.getTime()))) throw new Error("from and to must be ISO timestamps");
  return { subdivisionKey, label, from: dates[0]!, to: dates[1]! };
}
