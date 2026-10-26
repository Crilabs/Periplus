import { z } from "zod";
import { FACT_SCHEMAS } from "@/config/fact-schema";
import { getConfig } from "@/lib/config";
import type { AttributeDef, FactLevel, FactSchema } from "./schema-types";

export class UnknownAttribute extends Error {
  constructor(
    readonly key: string,
    readonly version: string,
  ) {
    super(`Unknown fact attribute ${key} in fact schema ${version}`);
    this.name = "UnknownAttribute";
  }
}

export class InvalidFactValue extends Error {
  constructor(
    readonly key: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    const detail = issues.map((i) => `${i.path.join(".") || "(value)"}: ${i.message}`).join("; ");
    super(`Invalid value for fact attribute ${key}: ${detail}`);
    this.name = "InvalidFactValue";
  }
}

/** The fact schema of `version`, by default the active one (`config/fact-schema/active.json`). */
export function getFactSchema(version: string = getConfig().factSchema.version): FactSchema {
  const schema = FACT_SCHEMAS[version];
  if (!schema) throw new Error(`Unknown fact schema version ${version}`);
  return schema;
}

/** The attribute `key` on any level of the fact schema; throws `UnknownAttribute`. */
export function attributeDef(key: string, version?: string): AttributeDef {
  const schema = getFactSchema(version);
  for (const defs of Object.values(schema.levels)) {
    const def = defs.find((d) => d.key === key);
    if (def) return def;
  }
  throw new UnknownAttribute(key, schema.version);
}

/** Parses `value` against the attribute's value schema; returns the parsed value or throws `InvalidFactValue`. */
export function validateFactValue(key: string, value: unknown, version?: string): unknown {
  const parsed = attributeDef(key, version).value.safeParse(value);
  if (!parsed.success) throw new InvalidFactValue(key, parsed.error.issues);
  return parsed.data;
}

export type TextFactResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "unknown_attribute" | "not_text" | "invalid_value" };

/**
 * Checks a value a model extracted from a text: the attribute must exist on `level` and allow origin `text`;
 * `raw` is parsed against `textValue` (or `value`), mapped by `fromText` and parsed against `value`.
 */
export function validateTextFact(level: FactLevel, attribute: string, raw: unknown, version?: string): TextFactResult {
  const def = getFactSchema(version).levels[level].find((d) => d.key === attribute);
  if (!def) return { ok: false, reason: "unknown_attribute" };
  if (!def.origins.includes("text")) return { ok: false, reason: "not_text" };
  const text = (def.textValue ?? def.value).safeParse(raw);
  if (!text.success) return { ok: false, reason: "invalid_value" };
  const stored = def.value.safeParse(def.fromText ? def.fromText(text.data) : text.data);
  if (!stored.success) return { ok: false, reason: "invalid_value" };
  return { ok: true, value: stored.data };
}

/**
 * The text attributes of `level`, one line each: `key — description — value format (JSON Schema)`; the description is
 * the one for texts (`textDescription`) where the attribute has one.
 */
export function attributesForPrompt(level: FactLevel, version?: string): string {
  return getFactSchema(version)
    .levels[level].filter((d) => d.origins.includes("text"))
    .map((d) => {
      const format: Record<string, unknown> = z.toJSONSchema(d.textValue ?? d.value, { unrepresentable: "any" });
      delete format.$schema;
      return `${d.key} — ${d.textDescription ?? d.description} — ${JSON.stringify(format)}`;
    })
    .join("\n");
}

/** The list attributes that carry safety entries: prompt v5 keeps all their entries first at the fact limit (ruling M7-FIN-R1). */
export const SAFETY_LIST_ATTRIBUTES = ["prohibitions", "hazards", "restricted_zones"] as const;

/** JSON with object keys sorted at every depth and no whitespace: equal values give equal strings. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return v;
}
