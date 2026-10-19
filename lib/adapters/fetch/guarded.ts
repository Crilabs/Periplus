import { lookup as dnsLookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher } from "undici";
import { getEnv } from "@/lib/env";
import { makeResponse, readBodyCapped, RetryableHttpError, transportOverride, type Transport } from "../http";
import { BlockedUrlError, isPublicAddress } from "./ssrf";

/** All addresses of a host, as `dns.lookup(host, { all: true })` gives them. */
export type ResolveAll = (host: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolveAll: ResolveAll = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))),
  );

/** A connection refused because the host resolved to (or is) a non-public address. */
export class BlockedAddressError extends BlockedUrlError {
  constructor(host: string, address: string) {
    super(`${host} (${address})`);
    this.name = "BlockedAddressError";
  }
}

/** `net.connect`'s `lookup`: resolves, and fails when any address of the host is not allowed. */
function guardedLookup(resolveAll: ResolveAll, isAllowedAddress: (ip: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolveAll(hostname).then(
      (found) => {
        const addresses = options.family === 4 || options.family === 6 ? found.filter((a) => a.family === options.family) : found;
        const bad = found.find((a) => !isAllowedAddress(a.address));
        if (bad) return callback(new BlockedAddressError(hostname, bad.address), "", 0);
        if (addresses.length === 0) {
          const error: NodeJS.ErrnoException = new Error(`no address for ${hostname}`);
          error.code = "ENOTFOUND";
          return callback(error, "", 0);
        }
        if (options.all) return (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };
}

/**
 * An undici dispatcher that checks the address it actually connects to (closes DNS rebinding between a URL check
 * and the request): a host name is resolved by the guard and refused when any of its addresses is not public; an
 * IP literal is checked directly. A refused connection fails with `BlockedAddressError`. Tests inject `resolveAll`
 * and `isAllowedAddress` (the test site listens on 127.0.0.1).
 */
export function createGuardedAgent(opts: { resolveAll?: ResolveAll; isAllowedAddress?: (ip: string) => boolean } = {}): Agent {
  const isAllowedAddress = opts.isAllowedAddress ?? isPublicAddress;
  const base = buildConnector({ lookup: guardedLookup(opts.resolveAll ?? systemResolveAll, isAllowedAddress) });
  return new Agent({
    connect(options, callback) {
      const host = options.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && !isAllowedAddress(host)) return callback(new BlockedAddressError(host, host), null);
      base(options, callback);
    },
  });
}

/** The `BlockedUrlError` somewhere in an error's cause chain (undici wraps connect errors in "fetch failed"). */
export function blockedCause(error: unknown): BlockedUrlError | null {
  for (let e = error as { cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e instanceof BlockedUrlError) return e;
  }
  return null;
}

/** `fetch` through `dispatcher` (undici's fetch: the global one cannot take an undici dispatcher of another version). */
export function guardedFetch(url: string, init: Parameters<typeof undiciFetch>[1] & { dispatcher: Dispatcher }) {
  return undiciFetch(url, init);
}

/**
 * The network transport of the crawl: like `fetchTransport`, but every connection goes through a guarded agent,
 * the body is read only up to `maxBodyBytes`, and redirects are followed only on request (`redirect: "follow"`):
 * a new caller gets the 3xx itself instead of silently skipping the crawl's per-hop checks. A refused address is a `BlockedUrlError` (not retried); other
 * network failures and timeouts are `RetryableHttpError`.
 */
export function createGuardedTransport(dispatcher: Dispatcher = createGuardedAgent()): Transport {
  return async (req) => {
    const method = req.method ?? "GET";
    try {
      const res = await guardedFetch(req.url, {
        method,
        body: req.body,
        headers: req.headers,
        redirect: req.redirect ?? "manual",
        signal: AbortSignal.timeout(req.timeoutMs),
        dispatcher,
      });
      const { body, truncated } = await readBodyCapped(res.body as ReadableStream<Uint8Array> | null, req.maxBodyBytes);
      return makeResponse(res.status, body, { headers: Object.fromEntries(res.headers), finalUrl: res.url || req.url, truncated });
    } catch (error) {
      const blocked = blockedCause(error);
      if (blocked) throw blocked;
      throw new RetryableHttpError(`${method} ${req.url} failed: ${(error as Error).message}`, undefined, { cause: error });
    }
  };
}

let sharedAgent: Agent | undefined;
let sharedTransport: Transport | undefined;

/** The process-wide guarded agent (crawl requests and the renderer's sub-requests). */
export function getGuardedAgent(): Agent {
  return (sharedAgent ??= createGuardedAgent());
}

/** The crawl transport: the one `setTransport` installed (tests: fixture replay), else the guarded network. */
export function getCrawlTransport(): Transport {
  const override = transportOverride();
  if (override) return override;
  if (getEnv().NODE_ENV === "test") throw new Error("no transport set under test: install one with setTransport");
  return (sharedTransport ??= createGuardedTransport(getGuardedAgent()));
}
