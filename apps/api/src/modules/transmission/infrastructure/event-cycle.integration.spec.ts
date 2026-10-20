import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  createPgliteDatabase,
  documents,
  issuerEvents,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { FakeSifenGateway, SifenTimeoutError, sifenScenarios } from '@sifen/sifen-gateway';
import { generateDevCertificate } from '../../../../test/support/dev-certificate.js';
import { seedDocuments } from '../../../../test/support/document-seed.js';
import { createTenantCycleFactory } from '../../../worker/tenant-cycle-factory.js';

/** Spec: HU-E8-04 (slice D). A tenant's cycle signs, sends and settles an issuer event end to end. */
describe('the transmission cycle with issuer events', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let documentId: string;
  let eventId: string;
  const gateway = new FakeSifenGateway();

  beforeEach(async () => {
    gateway.reset();
    handle = createPgliteDatabase();
    await handle.migrate();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    tenantId = tenant.id;
    const [doc] = await seedDocuments(handle.db, tenantId, ['approved']);
    documentId = doc.id;
    const [event] = await handle.db
      .insert(issuerEvents)
      .values({
        tenantId,
        environment: 'test',
        kind: 'cancellation',
        eventId: 1n,
        documentId,
        reason: 'Error en los datos del receptor',
      })
      .returning();
    eventId = event.id;
  });

  afterEach(async () => {
    await handle.close();
  });

  const runCycle = () => {
    const dev = generateDevCertificate();
    const factory = createTenantCycleFactory({
      db: handle.db,
      gateway,
      certificates: {
        open: () => Promise.resolve({ p12: Buffer.from(dev.p12), password: dev.password }),
      },
      cscs: { get: () => Promise.resolve(null) },
    });
    return factory(tenantId).run();
  };
  const eventRow = async () =>
    (await handle.db.select().from(issuerEvents).where(eq(issuerEvents.id, eventId)))[0];
  const documentStatus = async () =>
    (await handle.db.select().from(documents).where(eq(documents.id, documentId)))[0].status;

  it('signs a pending cancellation, sends it, settles it and cancels the document', async () => {
    gateway.enqueue(
      'enviarEventos',
      sifenScenarios.eventosProcesados([
        { id: '1', dEstRes: 'Aprobado', mensajes: [{ dCodRes: '0600', dMsgRes: 'Registrado' }] },
      ]),
    );

    const report = await runCycle();

    expect(report.failures).toEqual([]);
    expect(report.events).toMatchObject({ signed: 1, send: { status: 'sent', approved: 1 } });
    expect(gateway.callsTo('enviarEventos')).toHaveLength(1);
    expect(gateway.callsTo('enviarEventos')[0]?.[0].eventos[0]).toContain('<Signature');
    expect(await eventRow()).toMatchObject({ status: 'approved', responseCode: '0600' });
    expect(await documentStatus()).toBe('cancelled');
    const actions = (await handle.db.select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual(['document.cancelled', 'issuer_event.approved']);
  });

  it('leaves the event unknown when the send gets no answer, and never sends it twice', async () => {
    gateway.enqueue('enviarEventos', new SifenTimeoutError('enviarEventos'));

    await runCycle();
    const second = await runCycle();

    expect(gateway.callsTo('enviarEventos')).toHaveLength(1);
    expect(second.events?.send).toEqual({ status: 'empty' });
    expect(await eventRow()).toMatchObject({ status: 'unknown' });
    expect(await documentStatus()).toBe('approved');
  });
});
