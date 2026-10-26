import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { altText, buildPlacePrompt, loadPromptBlocks } from "@/lib/domain/images/prompt";
import type { PlaceImageInput } from "@/lib/domain/images/place-input";

const cfg = () => getConfig();

function input(over: Partial<PlaceImageInput> = {}): PlaceImageInput {
  return {
    geoObjectId: "g1",
    publicId: null,
    kind: "anchorage",
    lon: 10,
    lat: 40,
    country: "GR",
    subdivisionKey: null,
    openingBearing: null,
    rays: null,
    town: null,
    cove: null,
    ...over,
  };
}
const town = { geoObjectId: "t1", lon: 10.01, lat: 40.01 };

describe("buildPlacePrompt", () => {
  it("prompt for anchorage removes boats", () => {
    const { text, promptVersion } = buildPlacePrompt(input(), "midday", false, cfg());
    expect(promptVersion).toBe(2);
    expect(text).toMatchSnapshot();
  });

  it("prompt for marina keeps boats in evening light", () => {
    expect(buildPlacePrompt(input({ kind: "marina" }), "evening", false, cfg()).text).toMatchSnapshot();
  });

  it("an evening anchorage keeps the boats of the render and adds none, a midday one removes them", () => {
    const evening = buildPlacePrompt(input({ town }), "evening", false, cfg()).text;
    expect(evening).toContain("keep them in the same places");
    expect(evening).not.toContain("lying at anchor");
    expect(evening).not.toContain("Remove all boats");
    expect(buildPlacePrompt(input({ town }), "midday", false, cfg()).text).toContain("Remove all boats");
  });

  it("prompt v2 keeps hazards for every kind and light, and paints nothing onto the water", () => {
    for (const kind of ["anchorage", "mooring_field", "marina", "port"] as const) {
      for (const light of ["midday", "evening"] as const) {
        const { text } = buildPlacePrompt(input({ kind }), light, false, cfg());
        expect(text).toContain("fish farms");
        expect(text).toContain("no buildings, huts or platforms on the water");
      }
    }
  });

  it("no near-town block exists any more", () => {
    const blocks = loadPromptBlocks("generate-place-image", 2);
    expect(blocks.boats_near_town).toBeUndefined();
    expect(blocks.composition_near_town).toBeUndefined();
  });

  it("watermark block only for watermarked core imagery", () => {
    const on = buildPlacePrompt(input(), "midday", true, cfg()).text;
    const off = buildPlacePrompt(input(), "midday", false, cfg()).text;
    expect(on).toContain("Remove the semi-transparent overlay band");
    expect(off).not.toContain("overlay band");
  });
});

describe("loadPromptBlocks", () => {
  it("missing block throws with its name", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompts-"));
    mkdirSync(join(dir, "generate-place-image"));
    writeFileSync(join(dir, "generate-place-image", "v2.md"), "## scene\nA {{scene}}.\n\n## preserve\nKeep.\n");
    expect(loadPromptBlocks("generate-place-image", 2, dir)).toEqual({ scene: "A {{scene}}.", preserve: "Keep." });
    expect(() => buildPlacePrompt(input(), "midday", false, cfg(), dir)).toThrow(/block "boats_remove"/);
    expect(() => loadPromptBlocks("generate-place-image", 3, dir)).toThrow(/v3\.md/);
  });
});

describe("altText", () => {
  it("alt text starts with KI-Illustration: and names the kind, in the evening with „am Abend“", () => {
    expect(altText(input(), "midday", cfg())).toBe("KI-Illustration: Bucht mit Ufer und Hängen, Blick vom Wasser");
    expect(altText(input({ town }), "evening", cfg())).toBe("KI-Illustration: Bucht mit Ufer und Hängen, Blick vom Wasser, am Abend");
    expect(altText(input({ kind: "marina" }), "evening", cfg())).toBe("KI-Illustration: Marina mit Becken und Stegen, Blick vom Wasser, am Abend");
    for (const kind of ["anchorage", "mooring_field", "marina", "port"] as const) {
      expect(altText(input({ kind }), "evening", cfg()).split(/\s+/).length).toBeLessThanOrEqual(15);
    }
  });
});
