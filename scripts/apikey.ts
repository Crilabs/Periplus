import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../lib/db/client";
import { createApiClient, type ApiScope } from "../lib/domain/api-clients";

const SCOPES: readonly ApiScope[] = ["delivery:read", "reports:write"];

export function parseArgs(argv: string[]): { name: string; scopes: ApiScope[] } {
  const [command, name, ...rest] = argv;
  if (command !== "create" || !name) throw new Error("usage: apikey.ts create <name> --scope <scope> [--scope <scope> ...]");
  const scopes: ApiScope[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (rest[i] !== "--scope" || !value) throw new Error(`unexpected argument: ${rest[i]}`);
    if (!SCOPES.includes(value as ApiScope)) throw new Error(`unknown scope: ${value} (allowed: ${SCOPES.join(", ")})`);
    scopes.push(value as ApiScope);
  }
  if (scopes.length === 0) throw new Error("at least one --scope is required");
  return { name, scopes };
}

async function main(): Promise<void> {
  const { name, scopes } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    const { key } = await createApiClient(db, { name, scopes });
    process.stdout.write(`${key}\n`);
    process.stderr.write("Store this key now; it cannot be shown again.\n");
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
