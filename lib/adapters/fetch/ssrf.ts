import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** A URL Periplus must not request: not http(s), or a host in a private, loopback or link-local network. */
export class BlockedUrlError extends Error {
  constructor(readonly url: string) {
    super(`blocked request to a non-public address: ${url}`);
    this.name = "BlockedUrlError";
  }
}

export type ResolveHost = (host: string) => Promise<string[]>;

/** Networks no crawl may reach: this host, private networks, cloud metadata (169.254.169.254), CGNAT. */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
BLOCKED.addAddress("::", "ipv6");
BLOCKED.addAddress("::1", "ipv6");
BLOCKED.addSubnet("fc00::", 7, "ipv6");
BLOCKED.addSubnet("fe80::", 10, "ipv6");

/** The eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 counts as two). */
function ipv6Groups(ipv6: string): number[] {
  let text = ipv6.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const parse = (part: string | undefined) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const front = parse(head);
  const back = parse(tail);
  return tail === undefined ? front : [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:10.0.0.1`, `::ffff:a00:1`), else null. */
function mappedIpv4(ipv6: string): string | null {
  const g = ipv6Groups(ipv6);
  if (g.length !== 8 || g.slice(0, 5).some((x) => x !== 0) || g[5] !== 0xffff) return null;
  return [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join(".");
}

/** Whether an IP address lies outside every blocked network (IPv4-mapped IPv6 judged by its IPv4). */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, "ipv4");
  if (family === 6) {
    const v4 = mappedIpv4(ip);
    if (v4) return !BLOCKED.check(v4, "ipv4");
    return !BLOCKED.check(ip, "ipv6");
  }
  return false;
}

const systemResolve: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether Periplus may request `url` from its own network: http(s) only, and every A/AAAA address of the host
 * (an IP literal is checked directly) is public. A host that does not resolve is not public. Chromium resolves
 * again when it connects, so this does not stop DNS rebinding between the check and the request.
 */
export async function isPublicHttpUrl(url: string, resolve: ResolveHost = systemResolve): Promise<boolean> {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPublicAddress(host);
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

/**
 * Check without DNS for URLs a remote service (Jina, Firecrawl) fetches: http(s), not `localhost`, and not a
 * private IP literal. The service resolves the host in its own network, so a name cannot reach ours.
 */
export function isPublicUrlLiteral(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  return isIP(host) ? isPublicAddress(host) : true;
}
