import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * Lab script (pilot "Revier-Suche", spec 2026-10-28): every stage reads and writes JSON/JSONL files in one directory
 * outside the repo. Nothing here touches the database or the network.
 */

const DEFAULT_DIR = "/private/tmp/claude-501/-Users-christian-Code-periplus/f0b9bd5c-4e73-45b5-90c3-62a74845f3d4/scratchpad/pilot-revier";

/** The pilot's directory (`PILOT_DIR` or the scratchpad default), created on first use. */
export async function pilotDir(): Promise<string> {
  const dir = process.env.PILOT_DIR ?? DEFAULT_DIR;
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function readJsonl<T>(dir: string, name: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path.join(dir, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

export async function appendJsonl<T>(dir: string, name: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return;
  await appendFile(path.join(dir, name), rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

export async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(dir: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, name), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
