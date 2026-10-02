/**
 * SSRF address policy for webhook delivery (HU-E11-01). A destination is allowed only when every
 * address its hostname resolves to is public: anything private, loopback, link-local (cloud
 * metadata included), CGNAT, multicast, reserved, documentation or transitional (mapped, NAT64,
 * 6to4, Teredo) that points at such a range is blocked. Anything unparseable is blocked too.
 */

type Octets = readonly [number, number, number, number];

const DOTTED = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/;

function parseIpv4(address: string): Octets | undefined {
  if (!DOTTED.test(address)) return undefined;
  const parts = address.split('.').map(Number);
  if (parts.some((part) => part > 255)) return undefined;
  return parts as unknown as Octets;
}

/** [prefix address, prefix length] of every blocked IPv4 range. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const toInt = ([a, b, c, d]: Octets): number => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

function blockedV4(octets: Octets): boolean {
  const value = toInt(octets);
  return BLOCKED_V4.some(([prefix, length]) => {
    const base = toInt(parseIpv4(prefix) as Octets);
    const mask = (0xffffffff << (32 - length)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

/** Eight 16-bit groups, or undefined when the text is not a valid IPv6 address. */
function parseIpv6(address: string): number[] | undefined {
  let text = address;
  const tail = text.slice(text.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return undefined;
    text = `${text.slice(0, text.lastIndexOf(':') + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const group = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups = part.split(':');
    return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))
      ? groups.map((g) => parseInt(g, 16))
      : undefined;
  };
  const head = group(halves[0]);
  const rest = halves.length === 2 ? group(halves[1]) : [];
  if (!head || !rest) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - rest.length;
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...rest] : undefined;
}

const embedded = (hi: number, lo: number): Octets => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function blockedV6(g: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  const prefixZero = (n: number) => g.slice(0, n).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d, includes :: and ::1).
  if (prefixZero(5) && (g5 === 0xffff || g5 === 0)) return blockedV4(embedded(g6, g7));
  // NAT64: 64:ff9b::/96 embeds an IPv4 address; 64:ff9b:1::/48 is local-use.
  if (g0 === 0x64 && g1 === 0xff9b) {
    return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 ? blockedV4(embedded(g6, g7)) : true;
  }
  if ((g0 & 0xe000) !== 0x2000) return true; // only global unicast 2000::/3 is ever allowed
  if (g0 === 0x2002) return blockedV4(embedded(g1, g2)); // 6to4
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0x0db8)) return true; // Teredo, documentation
  return false;
}

/** True when the textual IP must not be connected to. Fails closed on anything unparseable. */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return blockedV4(v4);
  if (!address.includes(':')) return true;
  const v6 = parseIpv6(address);
  return v6 === undefined || blockedV6(v6);
}
