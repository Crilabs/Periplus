import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { suggestType } from "@/lib/domain/sources/type-hints";

const proposals = () => getConfig().discovery.proposals;

describe("suggestType", () => {
  it("suggestType: forum urls make a forum, otherwise trip_report", () => {
    expect(
      suggestType(["https://x.com/forum/viewtopic.php?t=1", "https://x.com/forum/t2", "https://x.com/about"], proposals()),
    ).toBe("forum");
    expect(suggestType(["https://x.com/forum/1", "https://x.com/a", "https://x.com/b"], proposals())).toBe("trip_report");
    expect(suggestType([], proposals())).toBe("trip_report");
  });

  it("follows the order of the hints", () => {
    expect(suggestType(["https://marina-x.com/guide.pdf", "https://marina-x.com/b"], proposals())).toBe("marina");
    expect(suggestType(["https://x.gov.gr/a", "https://x.gov.gr/b"], proposals())).toBe("authority");
    expect(suggestType(["https://x.com/files/Saronic.PDF"], proposals())).toBe("pilot_guide");
    expect(suggestType(["https://x.de/2019/06/toern"], proposals())).toBe("trip_report");
  });
});
