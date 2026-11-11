import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import {
  WEBHOOK_EVENT_TYPES,
  tenants,
  webhookDeliveries,
  webhookEndpoints,
} from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const RECEPTION_EVENTS = [
  'reception.document.confirmed',
  'reception.document.needs_review',
  'reception.document.extraction_failed',
  'reception.document.updated',
] as const;

const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const SEALED_2 = { ...SEALED, keyId: 'k2', ciphertext: 'BB==' };

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/** Statements are separated by `--> statement-breakpoint` (function bodies contain semicolons). */
function rollbackStatements(file: string): string[] {
  const path = fileURLToPath(new URL(`../migrations/rollback/${file}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

/** Spec: reception R4.5 (ADR-0028). The webhook event catalogue grows by the reception events. */
describe('reception webhook event types', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    return { db: handle.db, tenantId: tenant.id };
  }

  const endpoint = (tenantId: string, events: string[] = []) => ({
    tenantId,
    url: 'https://example.com/hooks/sifen',
    sealed: SEALED,
    events,
  });

  /** The CHECK constraints as the database really holds them, not as the TS list claims. */
  async function constraintDefinitions(db: DatabaseHandle['db']) {
    return queryRows<{ name: string; def: string }>(
      db,
      sql`select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
          where conname in ('webhook_endpoints_events_valid', 'webhook_deliveries_event_type_valid')`,
    );
  }

  it('lists the reception events after the document ones', () => {
    expect(WEBHOOK_EVENT_TYPES.slice(-4)).toEqual([...RECEPTION_EVENTS]);
  });

  it('holds exactly WEBHOOK_EVENT_TYPES in both CHECK constraints (parity with the database)', async () => {
    const { db } = await seed();
    const defs = await constraintDefinitions(db);
    expect(defs).toHaveLength(2);
    for (const { def } of defs) {
      for (const type of WEBHOOK_EVENT_TYPES) expect(def).toContain(`'${type}'`);
      expect(def.match(/'[a-z_.]+'/g)).toHaveLength(WEBHOOK_EVENT_TYPES.length);
    }
  });

  it('lets an endpoint subscribe to the reception events and a delivery carry them', async () => {
    const { db, tenantId } = await seed();
    const [ep] = await db
      .insert(webhookEndpoints)
      .values(endpoint(tenantId, [...RECEPTION_EVENTS]))
      .returning();
    for (const [i, eventType] of RECEPTION_EVENTS.entries()) {
      await db.insert(webhookDeliveries).values({
        tenantId,
        endpointId: ep.id,
        eventId: `evt_0000000${String(i)}`,
        eventType,
        payload: { id: `evt_0000000${String(i)}` },
        nextAttemptAt: new Date('2026-11-10T00:00:00Z'),
      });
    }
    expect(await db.select().from(webhookDeliveries)).toHaveLength(4);
  });

  it('still rejects an unknown reception event', async () => {
    const { db, tenantId } = await seed();
    expect(
      await causeOf(
        db.insert(webhookEndpoints).values(endpoint(tenantId, ['reception.document.deleted'])),
      ),
    ).toContain('webhook_endpoints_events_valid');
  });

  it('keeps the guard trigger intact for an endpoint subscribed to reception events', async () => {
    const { db, tenantId } = await seed();
    await db.insert(webhookEndpoints).values(endpoint(tenantId, [...RECEPTION_EVENTS]));
    // Changing the filter is a plain update; the guard only polices identity and the secret.
    await withTenantTransaction(db, tenantId, (tx) =>
      tx.update(webhookEndpoints).set({ events: ['reception.document.confirmed'] }),
    );
    expect(
      await causeOf(
        withTenantTransaction(db, tenantId, (tx) =>
          tx.update(webhookEndpoints).set({ sealed: SEALED_2 }),
        ),
      ),
    ).toContain('rotation');
    expect(
      await causeOf(
        withTenantTransaction(db, tenantId, (tx) =>
          tx.update(webhookEndpoints).set({ tenantId: crypto.randomUUID() }),
        ),
      ),
    ).toBeTruthy();
  });

  it('rolls back to the document-only catalogue', async () => {
    const { db, tenantId } = await seed();
    for (const statement of rollbackStatements('0082_reception_webhook_events.down.sql')) {
      await db.execute(sql.raw(statement));
    }
    expect(
      await causeOf(
        db.insert(webhookEndpoints).values(endpoint(tenantId, ['reception.document.confirmed'])),
      ),
    ).toContain('webhook_endpoints_events_valid');
    await db.insert(webhookEndpoints).values(endpoint(tenantId, ['document.approved']));
  });
});
