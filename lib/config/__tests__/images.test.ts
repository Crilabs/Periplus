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
    expect(c.images.camera.rulesVersion).toBe("camera-3");
    expect(c.images.check.minWaterIoU.midday).toBe(0.8);
    expect(c.images.delivery.ktimatologio).toBe(false);
    expect(c.images.sources.ktimatologio.countries).toEqual(["GR"]);
    expect(c.images.light.townRadiusM).toBe(1500);
    expect(c.images.composition.nearTown.foregroundM).toBe(450);
    expect(c.images.composition.openWater).toEqual({ maxShoreM: 2000, shoreBelowCentreDeg: 8.3, zoom: "z2", coveMinDistanceM: 50 });
    expect(c.images.light.nearTown).toBe("midday");
    expect(c.images.scene.near_town.en).toContain("in front of a town");
    expect(c.budgets.openai.dailyEur).toBe(10);
    expect(c.models.imageTasks["generate-place-image"]).toEqual({
      model: "gpt-image-2.5-sunburst",
      promptVersion: 1,
      size: "1536x1024",
      quality: "high",
      timeoutSeconds: 300,
    });
    expect(c.models.pricesEurPerImage["gpt-image-2.5-sunburst"]!.high).toBe(0.25);
  });

  it("images.place job expiry covers the render, every edit with its watermark check, and the margin", () => {
    const c = getConfig();
    const task = c.models.imageTasks["generate-place-image"]!;
    const check = c.models.tasks["check-place-image"]!;
    // the check has its own short timeout, not the 600 s of a text call
    expect(check.timeoutSeconds).toBe(60);
    const worstCase = c.images.render.timeoutSeconds + c.images.check.maxAttempts * (task.timeoutSeconds + check.timeoutSeconds!) + 120;
    expect(worstCase).toBe(960);
    expect(c.queues["images.place"]!.expireInSeconds).toBeGreaterThanOrEqual(worstCase);

    // one second less than the worst case is refused
    const queues = structuredClone(loadConfig("config").queues) as Record<string, Record<string, unknown>>;
    queues["images.place"] = { ...queues["images.place"], expireInSeconds: worstCase - 1 };
    expect(() => loadConfig(configWith("queues", queues))).toThrow(/queues\.json: images\.place\.expireInSeconds 959 is below the worst case of an image job, 960 s/);
    // without its own timeout the check counts at callTimeoutSeconds (600): 120 + 2 × (300 + 600) + 120 = 2040
    const models = structuredClone(loadConfig("config").models) as { tasks: Record<string, Record<string, unknown>>; imageTasks: Record<string, Record<string, unknown>> };
    delete models.tasks["check-place-image"]!.timeoutSeconds;
    const dir = configWith("models", models);
    expect(() => loadConfig(dir)).toThrow(/images\.place\.expireInSeconds 1200 is below the worst case of an image job, 2040 s/);
    // the pg-boss default of 900 s counts when the queue sets none
    const bare = structuredClone(loadConfig("config").queues) as Record<string, Record<string, unknown>>;
    delete bare["images.place"]!.expireInSeconds;
    expect(() => loadConfig(configWith("queues", bare))).toThrow(/images\.place\.expireInSeconds 900 is below/);
  });

  it("shoreline angle below the image centre must stay above the bottom edge", () => {
    const images = structuredClone(loadConfig("config").images) as { camera: { fovDeg: number }; composition: { openWater: Record<string, unknown> } };
    images.composition.openWater.shoreBelowCentreDeg = images.camera.fovDeg / 2;
    expect(() => loadConfig(configWith("images", images))).toThrow(/shoreBelowCentreDeg/);
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
      "scene", "preserve", "boats_remove", "boats_keep", "boats_near_town", "composition_near_town", "do_not_add", "artefacts", "artefacts_watermark",
      "regenerate", "light_midday", "light_evening",
    ]);
    expect(readdirSync("config/prompts/generate-place-image")).toEqual(["v1.md"]);
  });
});
