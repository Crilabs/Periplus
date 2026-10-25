import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { ContractFile, Manifest } from "../contract";

/*
 * Consumer check of a subdivision package (plan M6 Task 15): what a foreign consumer sees, through the API only. Fetches the
 * current manifest, every linked file, checks each file's sha256 against the manifest and validates it with its own
 * Ajv (draft 2020-12) against the schema served by `GET /api/v3/schema/<version>/<file>`. No database, no project code
 * except types.
 */

const USAGE = "usage: delivery-consume.ts --base-url <https://…> --key <pk_…> --subdivision <key or sd_…> (or the key in PERIPLUS_API_KEY)";

export type ConsumedFile = { name: string; sha256Ok: boolean; schemaErrors: string[] };
export type ConsumeResult = { dataVersion: number; files: ConsumedFile[]; ok: boolean };

type PackageBody = Manifest & { links: Partial<Record<ContractFile, string>> };

/** `spots.json` → `spots.schema.json`, `coast.geojson` → `coast.schema.json` (the API's schema file names). */
const schemaName = (file: string) => `${file.replace(/\.(json|geojson)$/, "")}.schema.json`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Error text of a non-200 answer: status plus the API's `{ error: { code, message } }` when it has one. */
async function failure(res: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error) detail = ` ${body.error.code ?? ""}: ${body.error.message ?? ""}`.trimEnd();
  } catch {
    // no JSON body
  }
  return `GET ${what} → ${res.status}${detail}`;
}

/**
 * The URL of an API link under `base` (no trailing slash): a root-relative link (`/api/v3/…`) is appended to the base
 * URL, so a path prefix (`https://host/periplus`) is kept (final review M-4); an absolute link must have the base URL's
 * origin, else null — the key is never sent to another host (bundle H review).
 */
export function resolveLink(base: string, link: string): string | null {
  if (link.startsWith("/") && !link.startsWith("//")) return `${base}${link}`;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  return url.origin === new URL(base).origin ? url.toString() : null;
}

/** A warning for a base URL that sends the key in clear text: `http://` to a host other than localhost. */
export function baseUrlWarning(baseUrl: string): string | null {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  return `warning: ${url.origin} is plain http, the API key travels unencrypted; use https://`;
}

/**
 * Consumes the current package of `subdivision` (key, e.g. `GR-I`, or `sd_…`) from `baseUrl`. Throws when the manifest
 * cannot be fetched (wrong key, unknown subdivision, no valid package); every file problem is a finding of that file instead.
 * `manifest.json` has no hash in the manifest itself: it must equal the manifest `GET /package` answered.
 */
export async function consumePackage(input: {
  baseUrl: string;
  key: string;
  subdivision: string;
  fetch?: typeof fetch;
}): Promise<ConsumeResult> {
  const doFetch = input.fetch ?? fetch;
  const base = input.baseUrl.replace(/\/+$/, "");
  const get = (url: string) => doFetch(url, { headers: { authorization: `Bearer ${input.key}`, accept: "application/json" } });

  const packagePath = `/api/v3/subdivisions/${encodeURIComponent(input.subdivision)}/package`;
  const res = await get(resolveLink(base, packagePath)!);
  if (res.status !== 200) throw new Error(await failure(res, packagePath));
  const { links, ...manifest } = (await res.json()) as PackageBody;
  // a manifest since contract 3.0 names its scope; checked before any file is fetched
  const scope = (manifest as { scope?: { type?: unknown } }).scope;
  if (scope == null || typeof scope !== "object") {
    throw new Error(
      `${packagePath} answered a manifest that has no scope (schemaVersion ${String(manifest.schemaVersion)}); a subdivision package needs one`,
    );
  }
  if (manifest.scope.type !== "subdivision") throw new Error(`${packagePath} answered a ${String(scope.type)} package, not a subdivision package`);
  const dataVersion = manifest.scope.dataVersion;

  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));
  const expected = new Map(manifest.files.map((f) => [f.name, f.sha256]));
  const files: ConsumedFile[] = [];

  for (const [name, link] of Object.entries(links) as Array<[ContractFile, string]>) {
    const url = resolveLink(base, link);
    if (url === null) {
      // the key goes to the base URL's origin only
      files.push({ name, sha256Ok: false, schemaErrors: [`link to another origin, not fetched: ${link}`] });
      continue;
    }
    const fileRes = await get(url);
    if (fileRes.status !== 200) {
      files.push({ name, sha256Ok: false, schemaErrors: [await failure(fileRes, link)] });
      continue;
    }
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      files.push({ name, sha256Ok: false, schemaErrors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`] });
      continue;
    }
    const sha256Ok = name === "manifest.json" ? isDeepStrictEqual(data, manifest) : expected.get(name) === sha256(bytes);

    const schemaPath = `/api/v3/schema/${encodeURIComponent(manifest.schemaVersion)}/${schemaName(name)}`;
    const schemaRes = await get(resolveLink(base, schemaPath)!);
    if (schemaRes.status !== 200) {
      files.push({ name, sha256Ok, schemaErrors: [await failure(schemaRes, schemaPath)] });
      continue;
    }
    const validate = ajv.compile((await schemaRes.json()) as object);
    const schemaErrors = validate(data)
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`);
    files.push({ name, sha256Ok, schemaErrors });
  }

  // a file the manifest describes but the package does not link is missing
  for (const name of expected.keys()) {
    if (!files.some((f) => f.name === name)) files.push({ name, sha256Ok: false, schemaErrors: ["no link in the package"] });
  }
  return {
    dataVersion,
    files,
    ok: files.length > 0 && files.every((f) => f.sha256Ok && f.schemaErrors.length === 0),
  };
}

/** `--base-url`, `--key` (else `env.PERIPLUS_API_KEY`) and `--subdivision`, each exactly once. */
export function parseArgs(argv: string[], env: Record<string, string | undefined>): { baseUrl: string; key: string; subdivision: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!["--base-url", "--key", "--subdivision"].includes(flag) || !value || value.startsWith("--") || flag in values) throw new Error(USAGE);
    values[flag] = value;
  }
  const baseUrl = values["--base-url"];
  const key = values["--key"] ?? env.PERIPLUS_API_KEY;
  const subdivision = values["--subdivision"];
  if (!baseUrl || !key || !subdivision) throw new Error(USAGE);
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("--base-url must start with http:// or https://");
  return { baseUrl, key, subdivision };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const warning = baseUrlWarning(args.baseUrl);
  if (warning !== null) process.stderr.write(`${warning}\n`);
  const result = await consumePackage(args);
  out(`subdivision ${args.subdivision}, data version ${result.dataVersion}`);
  for (const f of result.files) {
    out(`${f.name.padEnd(20)} sha256 ${f.sha256Ok ? "ok" : "MISMATCH"}  schema ${f.schemaErrors.length === 0 ? "ok" : `${f.schemaErrors.length} error(s)`}`);
    for (const e of f.schemaErrors.slice(0, 10)) out(`  ${e}`);
    if (f.schemaErrors.length > 10) out(`  … ${f.schemaErrors.length - 10} more`);
  }
  out(result.ok ? "OK" : "FAILED");
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
