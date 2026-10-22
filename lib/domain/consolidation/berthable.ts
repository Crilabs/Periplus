/** Spec 17: no anchoring or a port → false; a confirmed anchorage, marina or mooring field → true; else no value. */
export function derivedBerthable(kind: string, status: string): boolean | null {
  if (status === "no_anchoring" || kind === "port") return false;
  if (status === "confirmed" && ["anchorage", "marina", "mooring_field"].includes(kind)) return true;
  return null;
}
