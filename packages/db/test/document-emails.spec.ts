import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/client.js';
import { documentEmails } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { causeOf, seedIssuerEvents } from './support/issuer-events-fixture.js';

/** Spec: HU-E11-02 (DB part). The email outbox: one row per document, retry queue and history. */
describe('document_emails', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    const seeded = await seedIssuerEvents();
    handle = seeded.handle;
    const email = (
      tenantId: string,
      documentId: string,
      overrides: Partial<typeof documentEmails.$inferInsert> = {},
    ): typeof documentEmails.$inferInsert => ({
      tenantId,
      documentId,
      recipient: 'cliente@example.com',
      nextAttemptAt: new Date('2026-10-20T00:00:00Z'),
      ...overrides,
    });
    return { ...seeded, email };
  }

  it('queues pending with no attempts, once per document', async () => {
    const { db, a, docA, email } = await seed();
    const [row] = await db.insert(documentEmails).values(email(a, docA)).returning();
    expect(row).toMatchObject({ status: 'pending', attemptCount: 0, sentAt: null });
    expect(await causeOf(db.insert(documentEmails).values(email(a, docA)))).toContain(
      'document_emails_document_key',
    );
  });

  it('rejects a document of another tenant', async () => {
    const { db, a, docB, email } = await seed();
    expect(await causeOf(db.insert(documentEmails).values(email(a, docB)))).toContain(
      'document_emails_tenant_document_fk',
    );
  });

  it('rejects inconsistent states', async () => {
    const { db, a, docA, email } = await seed();
    const bad: Partial<typeof documentEmails.$inferInsert>[] = [
      { status: 'unknown' },
      { status: 'sent', nextAttemptAt: null },
      { status: 'sent', nextAttemptAt: null, sentAt: null },
      { status: 'pending', sentAt: new Date() },
      { status: 'pending', nextAttemptAt: null },
      { attemptCount: -1 },
      { recipient: 'sin-arroba' },
      { status: 'skipped', nextAttemptAt: null },
      { recipient: null },
    ];
    for (const overrides of bad) {
      expect(
        await causeOf(db.insert(documentEmails).values(email(a, docA, overrides))),
        JSON.stringify(overrides),
      ).toContain('document_emails_');
    }
    await db
      .insert(documentEmails)
      .values(email(a, docA, { status: 'sent', nextAttemptAt: null, sentAt: new Date() }));
  });

  it('records a document without a receiver address as skipped', async () => {
    const { db, a, docA, email } = await seed();
    const [row] = await db
      .insert(documentEmails)
      .values(
        email(a, docA, {
          recipient: null,
          status: 'skipped',
          nextAttemptAt: null,
          lastError: 'no_receiver_email',
        }),
      )
      .returning();
    expect(row).toMatchObject({ status: 'skipped', recipient: null, nextAttemptAt: null });
  });

  it('isolates tenants under RLS', async () => {
    const { db, a, b, docA, email } = await seed();
    await db.insert(documentEmails).values(email(a, docA));
    expect(await withTenantTransaction(db, b, (tx) => tx.select().from(documentEmails))).toEqual(
      [],
    );
    expect(
      await withTenantTransaction(db, a, (tx) => tx.select().from(documentEmails)),
    ).toHaveLength(1);
    expect(
      await causeOf(
        withTenantTransaction(db, b, (tx) => tx.insert(documentEmails).values(email(a, docA))),
      ),
    ).toContain('row-level security');
  });
});
