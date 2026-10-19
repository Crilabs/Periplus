import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeResponse, type HttpRequest, type Transport } from "./http";

/**
 * Recorded HTTP responses for tests and the fixture script. Kept out of `./http` so the app bundle never
 * contains this dynamic filesystem access; only tests (via `test/setup.ts`) and scripts import it.
 */

const DEFAULT_FIXTURE_DIR = "test/fixtures/http";

type FixtureFile = {
  request: { method: string; url: string; body: string | null };
  status: number;
  bodyBase64: string;
};

/** sha256 hex of `method + " " + url + "\n" + body`: stable across processes and machines. */
export function fixtureKey(req: Pick<HttpRequest, "method" | "url" | "body">): string {
  return createHash("sha256")
    .update(`${req.method ?? "GET"} ${req.url}\n${req.body ?? ""}`)
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
    return makeResponse(fixture.status, new Uint8Array(Buffer.from(fixture.bodyBase64, "base64")));
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
    };
    const file = fixturePath(dir, req);
    await mkdir(join(dir, req.service), { recursive: true });
    await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
    return res;
  };
}
