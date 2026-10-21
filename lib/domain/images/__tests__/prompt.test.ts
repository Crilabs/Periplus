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
    ...over,
  };
}
const town = { geoObjectId: "t1", lon: 10.01, lat: 40.01 };

describe("buildPlacePrompt", () => {
  it("prompt for anchorage removes boats", () => {
    const { text, promptVersion } = buildPlacePrompt(input(), "midday", false, cfg());
    expect(promptVersion).toBe(1);
    expect(text).toMatchSnapshot();
  });

  it("prompt for marina keeps boats in evening light", () => {
    expect(buildPlacePrompt(input({ kind: "marina" }), "evening", false, cfg()).text).toMatchSnapshot();
  });

  it("anchorage near a town adds anchored boats, puts the town behind and uses midday light", () => {
    const { text } = buildPlacePrompt(input({ town }), "midday", false, cfg());
    expect(text).toMatchSnapshot();
    expect(text).toContain("lying at anchor");
    expect(text).not.toContain("Remove all boats");
  });

  it("a marina keeps its own boats even with a town nearby", () => {
    const { text } = buildPlacePrompt(input({ kind: "marina", town }), "evening", false, cfg());
    expect(text).toContain("keep them in the same places");
    expect(text).not.toContain("The anchorage fills the foreground");
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
    writeFileSync(join(dir, "generate-place-image", "v1.md"), "## scene\nA {{scene}}.\n\n## preserve\nKeep.\n");
    expect(loadPromptBlocks("generate-place-image", 1, dir)).toEqual({ scene: "A {{scene}}.", preserve: "Keep." });
    expect(() => buildPlacePrompt(input(), "midday", false, cfg(), dir)).toThrow(/block "boats_remove"/);
    expect(() => loadPromptBlocks("generate-place-image", 2, dir)).toThrow(/v2\.md/);
  });
});

describe("altText", () => {
  it("alt text starts with KI-Illustration:", () => {
    expect(altText(input(), "midday", cfg())).toBe("KI-Illustration: Bucht mit Ufer und Hängen, Blick vom Wasser");
    expect(altText(input({ kind: "marina" }), "evening", cfg())).toBe("KI-Illustration: Marina mit Becken und Stegen, Blick vom Wasser, am Abend");
    const near = altText(input({ town }), "midday", cfg());
    expect(near).toBe("KI-Illustration: Ankerplatz vor einem Ort, Blick vom Wasser");
    for (const t of [near, altText(input({ kind: "port" }), "evening", cfg())]) expect(t.split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});
