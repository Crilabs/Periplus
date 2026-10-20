import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPrompt } from "@/lib/ai/prompts";
import { getConfig, loadConfig } from "../index";

/** A copy of the repo config dir with `file` (without `.json`) replaced by `value`. */
function configWith(file: string, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "periplus-images-config-"));
  cpSync("config", dir, { recursive: true });
  writeFileSync(join(dir, `${file}.json`), JSON.stringify(value));
  return dir;
}

describe("images config", () => {
  it("images config loads with spec values", () => {
    const c = getConfig();
    expect(c.images.camera.tiltDeg).toBe(30);
    expect(c.images.camera.zooms.z1.heightM).toBe(260);
    expect(c.images.check.minWaterIoU.midday).toBe(0.8);
    expect(c.images.delivery.ktimatologio).toBe(false);
    expect(c.images.sources.ktimatologio.countries).toEqual(["GR"]);
    expect(c.budgets.openai.dailyEur).toBe(10);
    expect(c.models.imageTasks["generate-place-image"]).toEqual({
      model: "gpt-image-2.5-sunburst",
      promptVersion: 1,
      size: "1536x1024",
      quality: "high",
    });
    expect(c.models.pricesEurPerImage["gpt-image-2.5-sunburst"]!.high).toBe(0.25);
  });

  it("delivery switch needs every source", () => {
    const images = structuredClone(loadConfig("config").images) as Record<string, unknown>;
    const delivery = { ...(images.delivery as Record<string, boolean>) };
    delete delivery.sentinel2;
    expect(() => loadConfig(configWith("images", { ...images, delivery }))).toThrow(/images\.json/);
  });

  it("image task needs a per-image price", () => {
    const models = structuredClone(loadConfig("config").models) as Record<string, unknown>;
    models.pricesEurPerImage = {};
    expect(() => loadConfig(configWith("models", models))).toThrow(/no price for model gpt-image/);
  });

  it("check-place-image prompt has system and user sections", () => {
    const task = getConfig().models.tasks["check-place-image"]!;
    const prompt = loadPrompt("check-place-image", task.promptVersion);
    expect(prompt.system.length).toBeGreaterThan(0);
    expect(prompt.user.length).toBeGreaterThan(0);
  });

  it("generate-place-image prompt has every block", () => {
    const raw = readFileSync("config/prompts/generate-place-image/v1.md", "utf8");
    const blocks = [...raw.matchAll(/^## (\w+)$/gm)].map((m) => m[1]);
    expect(blocks).toEqual([
      "scene", "preserve", "boats_remove", "boats_keep", "do_not_add", "artefacts", "artefacts_watermark",
      "regenerate", "light_midday", "light_evening",
    ]);
    expect(readdirSync("config/prompts/generate-place-image")).toEqual(["v1.md"]);
  });
});
