import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, ImageryLight, ImagesConfig } from "@/lib/config";
import type { PlaceImageInput } from "./place-input";

/** The `## <name>` sections of `config/prompts/<task>/v<version>.md`, trimmed, by name. */
export function loadPromptBlocks(task: string, version: number, dir = "config/prompts"): Record<string, string> {
  const file = join(dir, task, `v${version}.md`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read prompt ${file} for task ${task}: ${(error as Error).message}`, { cause: error });
  }
  const sections: Record<string, string> = {};
  let current: string | undefined;
  for (const line of raw.split("\n")) {
    const heading = /^##\s+(\w+)\s*$/.exec(line);
    if (heading) {
      current = heading[1]!;
      sections[current] = "";
    } else if (current) {
      sections[current] += `${line}\n`;
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([name, text]) => [name, text.trim()]));
}

export type PromptConfig = { models: Pick<AppConfig["models"], "imageTasks">; images: Pick<ImagesConfig, "scene"> };

const TASK = "generate-place-image";

const sceneOf = (input: PlaceImageInput, cfg: Pick<PromptConfig, "images">) => cfg.images.scene[input.kind];

/**
 * The edit prompt of a place (spec 19, prompt v2): the blocks `scene, preserve, <boats>, hazards, do_not_add,
 * artefacts, [artefacts_watermark], regenerate, light_<light>` joined by a blank line. Boats are kept as the render
 * shows them for a marina or port and for every evening image (an anchorage at a town), removed otherwise; none are
 * ever added.
 */
export function buildPlacePrompt(
  input: PlaceImageInput,
  light: ImageryLight,
  watermarked: boolean,
  cfg: PromptConfig,
  dir?: string,
): { text: string; promptVersion: number } {
  const promptVersion = cfg.models.imageTasks[TASK]!.promptVersion;
  const blocks = loadPromptBlocks(TASK, promptVersion, dir);
  const block = (name: string): string => {
    const text = blocks[name];
    if (!text) throw new Error(`prompt ${TASK} v${promptVersion} has no block "${name}"`);
    return text;
  };
  const keep = input.kind === "marina" || input.kind === "port" || light === "evening";
  const parts = [
    block("scene").replace("{{scene}}", sceneOf(input, cfg).en),
    block("preserve"),
    block(keep ? "boats_keep" : "boats_remove"),
    block("hazards"),
    block("do_not_add"),
    block("artefacts"),
    ...(watermarked ? [block("artefacts_watermark")] : []),
    block("regenerate"),
    block(`light_${light}`),
  ];
  return { text: parts.join("\n\n"), promptVersion };
}

/** `KI-Illustration: <scene>, Blick vom Wasser[, am Abend]` (German, at most 15 words). */
export function altText(input: PlaceImageInput, light: ImageryLight, cfg: Pick<PromptConfig, "images">): string {
  return `KI-Illustration: ${sceneOf(input, cfg).de}, Blick vom Wasser${light === "evening" ? ", am Abend" : ""}`;
}
