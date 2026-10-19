import type { z } from "zod";

/** Compass sectors, clockwise from north; each covers ±22.5° around its centre. */
export const SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Sector = (typeof SECTORS)[number];

export const SECTOR_CENTER_DEG: Record<Sector, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

/** Where a fact's value may come from: a geometric computation, a source text, an observation. */
export type FactOrigin = "computed" | "text" | "observed";

export type FactLevel = "place" | "area" | "island" | "cape_strait" | "poi";

export type AttributeDef = {
  key: string;
  value: z.ZodType;
  /** Consolidation rule name (M5). */
  rule: string;
  origins: FactOrigin[];
  description: string;
};

export type FactSchema = { version: string; levels: Record<FactLevel, AttributeDef[]> };
