import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** One answer of the test site; `status` defaults to 200. */
export type SiteResponse = { status?: number; body: string | Uint8Array; headers?: Record<string, string> };

export type SiteServer = {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** Sets the answer for `path` (without query; the query is ignored); `null` removes it (404). */
  set(path: string, res: SiteResponse | null): void;
  /** Every request in order: path with query, lower-cased headers. */
  requests: Array<{ path: string; headers: Record<string, string> }>;
  close(): Promise<void>;
};

function flatHeaders(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : (value ?? "")]),
  );
}

/**
 * A local website for crawl tests on `127.0.0.1` with a free port: serves the answers set per path,
 * 404 for unknown paths, and 304 when a request's `If-None-Match` equals the answer's `etag` header.
 */
export async function startSiteServer(): Promise<SiteServer> {
  const pages = new Map<string, SiteResponse>();
  const requests: SiteServer["requests"] = [];

  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const headers = flatHeaders(req);
    requests.push({ path, headers });
    const page = pages.get(path.split("?")[0]!);
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const pageHeaders = Object.fromEntries(Object.entries(page.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const etag = pageHeaders.etag;
    if (etag !== undefined && headers["if-none-match"] === etag) {
      res.writeHead(304, { etag }).end();
      return;
    }
    res.writeHead(page.status ?? 200, pageHeaders).end(page.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    set(path, res) {
      if (res) pages.set(path, res);
      else pages.delete(path);
    },
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
