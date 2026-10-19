import { franc } from "franc";
import type { FetchConfig } from "@/lib/config";

/**
 * Language of a text as the ISO 639-1 code from `map` (ISO 639-3 → 639-1), detected by franc among the
 * configured languages only; null for text below 50 characters or when franc is undecided.
 */
export function detectLanguage(text: string, map: FetchConfig["languages"]): string | null {
  const code = franc(text, { only: Object.keys(map), minLength: 50 });
  return code === "und" ? null : (map[code] ?? null);
}
