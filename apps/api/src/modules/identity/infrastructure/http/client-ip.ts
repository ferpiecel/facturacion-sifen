import { isIPv4, isIPv6 } from 'node:net';

function expandIpv6(address: string): number[] | null {
  const parts = address.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((parts.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array<string>(parts.length === 2 ? missing : 0).fill('0'), ...right];
  const parsed = groups.map((group) => Number.parseInt(group, 16));
  return parsed.length === 8 && parsed.every((n) => Number.isInteger(n)) ? parsed : null;
}

/**
 * The throttle subject for a client address: IPv4 as is (an IPv4-mapped IPv6 address unwrapped), IPv6 collapsed
 * to its /64 (a single host owns a whole /64, so per-address keys would let it rotate through 2^64 of them),
 * anything else one fixed bucket. Pass it the address Fastify resolved from the socket or trusted proxy hops.
 */
export function normalizeClientIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const address = mapped ?? ip;
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return 'unknown';
  const groups = expandIpv6(address);
  if (!groups) return 'unknown';
  return `${groups
    .slice(0, 4)
    .map((n) => n.toString(16))
    .join(':')}::/64`;
}
