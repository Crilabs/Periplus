import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, ImageryLight, ImagesConfig } from "@/lib/config";
import { compositionFor } from "./light";
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

function sceneOf(input: PlaceImageInput, cfg: Pick<PromptConfig, "images">) {
  return compositionFor(input) === "near_town" ? cfg.images.scene.near_town : cfg.images.scene[input.kind];
}

/**
 * The edit prompt of a place: the blocks `scene, preserve, <boats>, [composition_near_town], do_not_add, artefacts,
 * [artefacts_watermark], regenerate, light_<light>` joined by a blank line. Boats are removed for an anchorage or
 * mooring field, kept for a marina or port, and `boats_near_town` for the near-town composition.
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
  const nearTown = compositionFor(input) === "near_town";
  const boats = nearTown ? "boats_near_town" : input.kind === "anchorage" || input.kind === "mooring_field" ? "boats_remove" : "boats_keep";
  const parts = [
    block("scene").replace("{{scene}}", sceneOf(input, cfg).en),
    block("preserve"),
    block(boats),
    ...(nearTown ? [block("composition_near_town")] : []),
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
