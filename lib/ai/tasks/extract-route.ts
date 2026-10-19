import { z } from "zod";
import { mooringKindEnum, type MooringKind } from "@/lib/db/schema/text";
import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import type { ModelTask } from "../types";

/*
 * Route of a trip report (spec 06): the stops of the voyage in the order the text tells them, each with a verbatim
 * quote, and the leg that led there when the text describes it. Long reports (> `routeSectionWords` words) are sent in
 * sections; the stops of all sections are joined in section order. The output schema keeps to what structured outputs
 * support; the limits (name ≤ 80, quote ≤ 300, `routeMaxStops` stops, Beaufort 0–12) are enforced when the answer is stored
 * (`lib/domain/extraction/routes.ts`), so one bad field drops one stop or one leg, not the whole answer.
 */

export type ExtractRouteInput = {
  /** Number of this section, from 1. */
  section: number;
  /** Number of sections of the report. */
  sections: number;
  /** The date the text counts as observed (YYYY-MM-DD). */
  observedAt: string;
  /** At most this many stops are looked at (`extraction.routeMaxStops`). */
  maxStops: number;
  /** The section's Markdown. */
  text: string;
};

export type RouteLeg = {
  distance_nm: number | null;
  duration_h: number | null;
  wind_direction: Sector | null;
  /** 0–12 (checked on receipt). */
  wind_beaufort: number | null;
  /** Verbatim excerpt stating the leg; without one the leg is dropped. */
  quote: string | null;
};

export type RouteStop = {
  /** The place as the text names it, at most 80 characters (checked on receipt). */
  name: string;
  /** YYYY-MM-DD, only when the text states it. */
  date: string | null;
  mooring: MooringKind;
  /** Verbatim excerpt of the text naming the stop, at most 300 characters (checked on receipt). */
  quote: string;
  /** The leg that led to this stop. */
  leg: RouteLeg | null;
};

export type ExtractRouteOutput = { stops: RouteStop[] };

const output: z.ZodType<ExtractRouteOutput> = z.object({
  stops: z.array(
    z.object({
      name: z.string(),
      date: z.string().nullable(),
      mooring: z.enum(mooringKindEnum.enumValues),
      quote: z.string(),
      leg: z
        .object({
          distance_nm: z.number().nullable(),
          duration_h: z.number().nullable(),
          wind_direction: z.enum(SECTORS).nullable(),
          wind_beaufort: z.number().int().nullable(),
          quote: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});

export const extractRouteTask: ModelTask<ExtractRouteInput, ExtractRouteOutput> = {
  name: "extract-route",
  output,
  variables: (input) => ({
    moorings: mooringKindEnum.enumValues.join(", "),
    sectors: SECTORS.join(", "),
    section: String(input.section),
    sections: String(input.sections),
    observed_at: input.observedAt,
    max_stops: String(input.maxStops),
    text: input.text,
  }),
};
