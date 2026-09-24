import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FORBIDDEN_IMPORT =
  /from\s+['"](@nestjs\/|fastify|drizzle-orm|bullmq|facturacionelectronicapy-)/;

describe('emission-ports.ts import boundaries', () => {
  it('imports no TIPS library, NestJS, Fastify, Drizzle, or BullMQ', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./emission-ports.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toMatch(FORBIDDEN_IMPORT);
  });
});
