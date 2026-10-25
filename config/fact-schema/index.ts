import type { FactSchema } from "@/lib/domain/facts/schema-types";
import { factSchemaV1 } from "./v1";
import { factSchemaV2 } from "./v2";
import { factSchemaV3 } from "./v3";
import { factSchemaV4 } from "./v4";

/**
 * Every fact schema version by its name; the one map both the config loader (`lib/config`) and the fact-schema access
 * (`lib/domain/facts/schema.ts`) read. A leaf module: it imports neither of them, so neither import closes a cycle.
 */
export const FACT_SCHEMAS: Readonly<Record<string, FactSchema>> = {
  [factSchemaV1.version]: factSchemaV1,
  [factSchemaV2.version]: factSchemaV2,
  [factSchemaV3.version]: factSchemaV3,
  [factSchemaV4.version]: factSchemaV4,
};
