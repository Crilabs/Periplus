import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_FILES, contractJsonSchema, jsonSchemaFileName, SCHEMA_VERSION } from "../contract";

/*
 * Writes the JSON schemas of the current contract version to `contract/schema/<version>/` from the zod schemas
 * (spec 08). The checked-in files must equal the generated ones (contract test); run after every schema change.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "contract", "schema", SCHEMA_VERSION);
mkdirSync(dir, { recursive: true });
for (const file of CONTRACT_FILES) {
  const name = jsonSchemaFileName(file);
  writeFileSync(path.join(dir, name), `${JSON.stringify(contractJsonSchema(SCHEMA_VERSION, name), null, 2)}\n`);
  process.stdout.write(`${path.relative(root, path.join(dir, name))}\n`);
}
