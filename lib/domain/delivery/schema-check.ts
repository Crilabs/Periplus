import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { contractJsonSchema, jsonSchemaFileName, SCHEMA_VERSION, type ContractFile } from "@/contract";

/*
 * JSON-schema check of a package file against the published schema of the contract version (spec 08: ajv, in
 * addition to the zod check while building). The zod-only refinements (five decimals) are not part of it.
 */

export type SchemaError = { path: string; message: string };

let ajv: Ajv2020 | undefined;
const validators = new Map<ContractFile, ValidateFunction>();

function validatorFor(file: ContractFile): ValidateFunction {
  let validate = validators.get(file);
  if (!validate) {
    ajv ??= addFormats(new Ajv2020({ allErrors: true, strict: true }));
    const schema = contractJsonSchema(SCHEMA_VERSION, jsonSchemaFileName(file));
    if (!schema) throw new Error(`No JSON schema for ${file} in contract ${SCHEMA_VERSION}`);
    validate = ajv.compile(schema);
    validators.set(file, validate);
  }
  return validate;
}

/** Every schema violation of `data` as `file`; path = JSON pointer of the offending value ("" = the root). */
export function checkJsonSchema(file: ContractFile, data: unknown): SchemaError[] {
  const validate = validatorFor(file);
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => ({ path: e.instancePath, message: e.message ?? e.keyword }));
}
