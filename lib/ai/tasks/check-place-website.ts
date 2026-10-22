import { z } from "zod";
import type { PlaceKind } from "@/lib/db/schema";
import type { ModelTask } from "../types";

/*
 * Is this search hit the website of this place (spec 16 C „Ist das die Website dieses Ortes?“)? Only for addresses
 * from the Google search: a hit can be a neighbouring marina, a charter company or a travel portal. Input: the place's
 * names and position, its kind as the seed guessed it, and the hit's page text; output: yes/no, a verbatim quote that
 * names the place, a confidence. The caller accepts a yes only with a confident, verifiable quote (`acceptWebsiteCheck`).
 */

export type CheckPlaceWebsiteInput = {
  /** Valid names of the place (any language). */
  names: string[];
  /** The island the place lies on, if any. */
  island: string | null;
  kindProposal: PlaceKind;
  lat: number;
  lon: number;
  url: string;
  /** The page as Markdown, at most `MAX_PAGE_CHARS` characters. */
  pageText: string;
};

export type CheckPlaceWebsiteOutput = { isOwnSite: boolean; quote: string; confidence: number };

/** Characters of the page text the model sees. */
export const MAX_PAGE_CHARS = 6000;

const output: z.ZodType<CheckPlaceWebsiteOutput> = z.object({
  isOwnSite: z.boolean(),
  quote: z.string(),
  confidence: z.number().min(0).max(1),
});

/** A latitude or longitude with its hemisphere: 35.10000 N, 4.20000 W. */
const coordinate = (value: number, positive: string, negative: string) => `${Math.abs(value).toFixed(5)} ${value < 0 ? negative : positive}`;

export const checkPlaceWebsiteTask: ModelTask<CheckPlaceWebsiteInput, CheckPlaceWebsiteOutput> = {
  name: "check-place-website",
  output,
  variables: (input) => ({
    names: input.names.join(", "),
    island: input.island ?? "(none known)",
    kind: input.kindProposal,
    position: `${coordinate(input.lat, "N", "S")}, ${coordinate(input.lon, "E", "W")}`,
    url: input.url,
    page: input.pageText.slice(0, MAX_PAGE_CHARS),
  }),
};
