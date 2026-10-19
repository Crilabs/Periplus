import type { z } from "zod";
import { factSchemaV1 } from "@/config/fact-schema/v1";
import { getConfig } from "@/lib/config";
import type { AttributeDef, FactSchema } from "./schema-types";

const SCHEMAS: Record<string, FactSchema> = { [factSchemaV1.version]: factSchemaV1 };

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
  const schema = SCHEMAS[version];
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
