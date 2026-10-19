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

/**
 * Networks no crawl may reach: this host, private networks, cloud metadata (169.254.169.254), CGNAT, IETF protocol
 * assignments, documentation, benchmarking, multicast, reserved and broadcast. IPv6 forms that embed an IPv4 address are judged by
 * that address (`isPublicAddress`).
 */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
BLOCKED.addAddress("::", "ipv6");
BLOCKED.addAddress("::1", "ipv6");
BLOCKED.addSubnet("100::", 64, "ipv6"); // discard-only
BLOCKED.addSubnet("2001:db8::", 32, "ipv6"); // documentation
BLOCKED.addSubnet("fc00::", 7, "ipv6");
BLOCKED.addSubnet("fe80::", 10, "ipv6");
BLOCKED.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local
BLOCKED.addSubnet("ff00::", 8, "ipv6");
// Teredo tunnels reach any IPv4 host; local-use NAT64 (RFC 8215) has no fixed place for the IPv4 address.
BLOCKED.addSubnet("2001::", 32, "ipv6");
BLOCKED.addSubnet("64:ff9b:1::", 48, "ipv6");

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

const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");

/**
 * The IPv4 address an IPv6 address carries: IPv4-mapped `::ffff:a.b.c.d`, IPv4-translated `::ffff:0:a.b.c.d`
 * (SIIT), IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::a.b.c.d` (RFC 6052) or 6to4 `2002:aabb:ccdd::`; else null.
 */
function embeddedIpv4(ipv6: string): string | null {
  const g = ipv6Groups(ipv6);
  if (g.length !== 8) return null;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!);
  if (zeros(0, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return null;
}

/** Whether an IP address lies outside every blocked network (an IPv6 address with an embedded IPv4 judged by both). */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, "ipv4");
  if (family === 6) {
    const embedded = embeddedIpv4(ip);
    if (embedded && BLOCKED.check(embedded, "ipv4")) return false;
    // `::a.b.c.d` lies in `::/96`, which is only blocked for `::` and `::1`: its IPv4 decides.
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
 * (an IP literal is checked directly) is public. A host that does not resolve is not public. The connection
 * resolves again, so this alone does not stop DNS rebinding: requests go through `createGuardedAgent` too.
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
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  return isIP(host) ? isPublicAddress(host) : true;
}
