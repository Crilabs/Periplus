import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { capBody, makeResponse, type HttpRequest, type Transport } from "./http";

/**
 * Recorded HTTP responses for tests and the fixture script. Kept out of `./http` so the app bundle never
 * contains this dynamic filesystem access; only tests (via `test/setup.ts`) and scripts import it.
 */

const DEFAULT_FIXTURE_DIR = "test/fixtures/http";

type FixtureFile = {
  request: { method: string; url: string; body: string | null };
  status: number;
  bodyBase64: string;
  /** Response headers (lower-case names); absent in fixtures recorded before M3. */
  headers?: Record<string, string>;
  /** URL after redirects; absent = the request URL. */
  finalUrl?: string;
};

/**
 * Headers never written into a fixture: cookies a site hands out are no test data, and some servers echo the
 * recording machine's public address back (Wikimedia: `x-client-ip`, inside `x-analytics`).
 */
const UNRECORDED_HEADERS = new Set(["set-cookie", "x-client-ip", "x-analytics"]);

/**
 * sha256 hex of `method + " " + url + "\n" + body`, plus `"\nredirect: manual"` for a request that follows no
 * redirects (a crawl hop answers with the 3xx itself, a followed request with its target): stable across processes
 * and machines, and unchanged for every request recorded before redirect modes existed.
 */
export function fixtureKey(req: Pick<HttpRequest, "method" | "url" | "body" | "redirect">): string {
  return createHash("sha256")
    .update(`${req.method ?? "GET"} ${req.url}\n${req.body ?? ""}${req.redirect === "manual" ? "\nredirect: manual" : ""}`)
    .digest("hex");
}

function fixturePath(dir: string, req: HttpRequest): string {
  return join(dir, req.service, `${fixtureKey(req)}.json`);
}

/** Replays recorded responses from `<dir>/<service>/<key>.json`; an unrecorded request is an error. */
export function fixtureTransport(dir: string = DEFAULT_FIXTURE_DIR): Transport {
  return async (req) => {
    let raw: string;
    try {
      raw = await readFile(fixturePath(dir, req), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`no fixture for ${req.service} ${req.method ?? "GET"} ${req.url}`);
    }
    const fixture = JSON.parse(raw) as FixtureFile;
    const { body, truncated } = capBody(new Uint8Array(Buffer.from(fixture.bodyBase64, "base64")), req.maxBodyBytes);
    return makeResponse(fixture.status, body, { headers: fixture.headers ?? {}, finalUrl: fixture.finalUrl ?? req.url, truncated });
  };
}

/**
 * Passes requests to `inner` and writes every 2xx response as a fixture that `fixtureTransport` replays. Other
 * answers (a 429, a 5xx of a service that is down) pass through unrecorded, so a failed recording run never leaves
 * an error behind as the "recorded" answer; `opts.recordErrors` records them too (for tests of error handling).
 */
export function recordingTransport(
  inner: Transport,
  dir: string = DEFAULT_FIXTURE_DIR,
  opts: { recordErrors?: boolean } = {},
): Transport {
  return async (req) => {
    const res = await inner(req);
    if ((res.status < 200 || res.status > 299) && !opts.recordErrors) return res;
    const fixture: FixtureFile = {
      request: { method: req.method ?? "GET", url: req.url, body: req.body ?? null },
      status: res.status,
      bodyBase64: Buffer.from(res.body).toString("base64"),
      headers: Object.fromEntries(Object.entries(res.headers).filter(([name]) => !UNRECORDED_HEADERS.has(name))),
      ...(res.finalUrl && res.finalUrl !== req.url ? { finalUrl: res.finalUrl } : {}),
    };
    const file = fixturePath(dir, req);
    await mkdir(join(dir, req.service), { recursive: true });
    await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
    return res;
  };
}
