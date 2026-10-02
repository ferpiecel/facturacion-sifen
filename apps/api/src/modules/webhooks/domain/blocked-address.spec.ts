import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './blocked-address.js';

describe('isBlockedAddress (HU-E11-01 SSRF policy)', () => {
  it.each([
    ['0.0.0.0', 'this network'],
    ['0.255.255.255', 'this network'],
    ['10.0.0.1', 'private 10/8'],
    ['10.255.255.255', 'private 10/8'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.255', 'CGNAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.168.1.1', 'private 192.168/16'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks IPv4 %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique local'],
    ['fd00::1', 'unique local'],
    ['fd00:ec2::254', 'AWS IPv6 metadata'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
    ['100::1', 'discard-only'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex form'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['64:ff9b::7f00:1', 'NAT64 to loopback'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 to metadata'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['2002:7f00:1::1', '6to4 to loopback'],
    ['2002:a00:1::1', '6to4 to 10/8'],
    ['fe80::1%eth0', 'zone id'],
    ['1::', 'outside global unicast'],
  ])('blocks IPv6 %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '198.17.255.255',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4009:81b::200e',
    '::ffff:8.8.8.8',
    '2002:808:808::1',
    '64:ff9b::808:808',
  ])('allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each(['', 'example.com', '999.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '::g', ':::', '1:2:3:4:5:6:7:8:9', 'http://1.1.1.1'])(
    'fails closed on the unparseable value %j',
    (value) => {
      expect(isBlockedAddress(value)).toBe(true);
    },
  );
});
