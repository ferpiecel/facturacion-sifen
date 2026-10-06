import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { installClientAddressPin, pinClientAddress } from './client-address';

const request = (headers: Record<string, string>, remoteAddress: string | undefined = '203.0.113.9') => ({
  headers: { ...headers },
  socket: { remoteAddress },
});

describe('pinClientAddress', () => {
  it('replaces a client-supplied X-Forwarded-For with the socket address', () => {
    const req = request({ 'x-forwarded-for': '6.6.6.6' });
    pinClientAddress(req, false);
    expect(req.headers['x-forwarded-for']).toBe('203.0.113.9');
  });

  it('sets it when the client sent none', () => {
    const req = request({});
    pinClientAddress(req, false);
    expect(req.headers['x-forwarded-for']).toBe('203.0.113.9');
  });

  it('drops X-Real-IP and Forwarded', () => {
    const req = request({ 'x-real-ip': '7.7.7.7', forwarded: 'for=8.8.8.8' });
    pinClientAddress(req, false);
    expect(req.headers).toEqual({ 'x-forwarded-for': '203.0.113.9' });
  });

  it('leaves every header alone behind a trusted upstream proxy', () => {
    const req = request({ 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.1' });
    pinClientAddress(req, true);
    expect(req.headers).toEqual({ 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.1' });
  });

  it('removes a spoofed header when the socket address is unknown', () => {
    const req = request({ 'x-forwarded-for': '6.6.6.6' }, undefined);
    pinClientAddress(req, false);
    expect(req.headers).toEqual({});
  });
});

describe('installClientAddressPin', () => {
  it('pins the address on every request event before the listeners run and is idempotent', () => {
    class FakeServer extends EventEmitter {}
    installClientAddressPin(FakeServer.prototype, false);
    installClientAddressPin(FakeServer.prototype, false);
    const server = new FakeServer();
    const seen: (string | undefined)[] = [];
    server.on('request', (req: ReturnType<typeof request>) => {
      seen.push(req.headers['x-forwarded-for']);
    });
    server.on('other', () => seen.push('other'));

    server.emit('request', request({ 'x-forwarded-for': '6.6.6.6' }));
    server.emit('other');

    expect(seen).toEqual(['203.0.113.9', 'other']);
  });
});
