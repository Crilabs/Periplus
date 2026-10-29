import { describe, expect, it } from "vitest";
import { validateMentions, type ExtractionOutput } from "../extract";

const markdown = [
  "# A week in the gulf",
  "",
  "On Tuesday we anchored in **Russian Bay** on the north side of the island in 5 m over sand and weed.",
  "The bay was calm overnight. Position given in the pilot: 37°31'N 23°27'E, which matched our plotter.",
  "",
  "Next morning we moved on.",
].join("\n");

const page = { url: "https://example.org/gulf", domain: "example.org", first_hand: true, page_kind: "trip_report" };
const quoteCfg = { minChars: 20, maxChars: 400 };

function output(mention: Partial<ExtractionOutput["mentions"][number]>): ExtractionOutput {
  return {
    mentions: [
      {
        name: "Russian Bay",
        aliases: [],
        area: "Poros",
        kind: "anchorage",
        coordinate_text: null,
        coordinate_quote: null,
        position_quote: null,
        berth_quote: "we anchored in Russian Bay on the north side of the island in 5 m over sand and weed",
        ...mention,
      },
    ],
  };
}

describe("validateMentions", () => {
  it("accepts a quote that differs from the markdown only in bold marks and line breaks", () => {
    const { mentions, dropped } = validateMentions(output({}), markdown, page, quoteCfg);
    expect(dropped).toEqual([]);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.berthQuote).toContain("Russian Bay");
    expect(mentions[0]?.firstHand).toBe(true);
  });

  it("drops a mention whose berth quote is not in the text", () => {
    const { mentions, dropped } = validateMentions(output({ berth_quote: "we anchored in Russian Bay in 12 m over rock and mud" }), markdown, page, quoteCfg);
    expect(mentions).toHaveLength(0);
    expect(dropped[0]?.reason).toBe("berth_quote not_found");
  });

  it("keeps a coordinate whose quote is in the text and parses it", () => {
    const { mentions } = validateMentions(
      output({ coordinate_text: "37°31'N 23°27'E", coordinate_quote: "Position given in the pilot: 37°31'N 23°27'E, which matched our plotter" }),
      markdown,
      page,
      quoteCfg,
    );
    expect(mentions[0]?.coordinate?.lat).toBeCloseTo(37.5167, 3);
  });

  it("takes the coordinate from the quote, never from the model's coordinate_text", () => {
    const { mentions } = validateMentions(
      output({ coordinate_text: "37°45'N 23°10'E", coordinate_quote: "Position given in the pilot: 37°31'N 23°27'E, which matched our plotter" }),
      markdown,
      page,
      quoteCfg,
    );
    expect(mentions[0]?.coordinate?.lat).toBeCloseTo(37.5167, 3);
    expect(mentions[0]?.coordinate?.lon).toBeCloseTo(23.45, 3);
  });

  it("nulls a coordinate whose quote is not in the text, but keeps the mention", () => {
    const { mentions } = validateMentions(
      output({ coordinate_text: "37°31'N 23°27'E", coordinate_quote: "The anchorage lies at 37°31'N 23°27'E according to our chart" }),
      markdown,
      page,
      quoteCfg,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.coordinate).toBeNull();
  });
});
