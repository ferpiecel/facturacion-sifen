import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createPgliteDatabase,
  tenantFiscalProfiles,
  tenants,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IngestSifenXml } from '../../application/ingest-sifen-xml.js';
import { computeCdcCheckDigit } from '../../../emission/domain/cdc.js';
import { computeRucCheckDigit } from '../../../fiscal-config/domain/ruc.js';
import { createDrizzleReceivedDocumentRepository } from './drizzle-received-document-repository.js';
import { createDrizzleTenantFiscalIdentity } from './drizzle-tenant-fiscal-identity.js';
import { InMemoryStorageProvider } from './in-memory-storage-provider.js';
import { Libxml2SifenXmlParser } from './libxml2-sifen-xml-parser.adapter.js';

const GOLDEN = fileURLToPath(
  new URL(
    '../../../../../test/fixtures/reception/sifen/factura_contado/documento.xml',
    import.meta.url,
  ),
);
const GOLDEN_CDC = '00000000000000000000000000000000000000000001';
const VALID_CDC_BODY = '0'.repeat(42) + '1';
const VALID_CDC = `${VALID_CDC_BODY}${String(computeCdcCheckDigit(VALID_CDC_BODY))}`;
/** The golden receiver is 80000001-8. */
const MATCH = { rucBase: '80000001', rucDv: 8 };

/** Spec: reception R3.3. Real parser, in-memory storage and the Drizzle stores on PGlite. */
describe('IngestSifenXml integration', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let storage: InMemoryStorageProvider;
  let counter: number;

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    [{ id: tenantId }] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    storage = new InMemoryStorageProvider();
    counter = 0;
  });
  afterEach(async () => {
    await handle.close();
  });

  const seedProfile = (ruc: { rucBase: string; rucDv: number }) =>
    handle.db.insert(tenantFiscalProfiles).values({
      tenantId,
      ...ruc,
      legalName: 'Empresa SA',
      taxpayerType: 'persona_juridica',
    });

  const useCase = () =>
    new IngestSifenXml({
      repository: createDrizzleReceivedDocumentRepository(handle.db),
      storage,
      parser: new Libxml2SifenXmlParser(),
      fiscalIdentity: createDrizzleTenantFiscalIdentity(handle.db),
      now: () => new Date('2026-11-06T12:00:00.000Z'),
      newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    });

  const golden = readFileSync(GOLDEN);
  // The anonymized golden carries a placeholder CDC and an issuer check digit that do not verify.
  const withValidCdc = new TextEncoder().encode(
    golden
      .toString('utf8')
      .replaceAll(GOLDEN_CDC, VALID_CDC)
      .replace(
        '<dDVEmi>3</dDVEmi>',
        `<dDVEmi>${String(computeRucCheckDigit('80000000'))}</dDVEmi>`,
      ),
  );

  it('confirms a valid document for the matching tenant and persists the graph', async () => {
    await seedProfile(MATCH);
    const result = await useCase().execute({ tenantId, xml: withValidCdc });
    expect(result).toMatchObject({
      created: true,
      events: ['reception.document.confirmed'],
      document: { status: 'confirmed', isOwnReceiver: true, version: 2 },
    });
    const graph = await createDrizzleReceivedDocumentRepository(handle.db).load(
      tenantId,
      result.document.id,
    );
    expect(graph?.header).toMatchObject({ cdc: VALID_CDC, totalAmount: '204000.00000000' });
    expect(graph?.items).toHaveLength(7);
    expect(graph?.confidences).toHaveLength(8);
    expect(await storage.exists(graph?.artifact?.storageKey ?? '')).toBe(true);
  });

  it('is idempotent: the same bytes return the stored document with created=false', async () => {
    await seedProfile(MATCH);
    const first = await useCase().execute({ tenantId, xml: withValidCdc });
    const second = await useCase().execute({ tenantId, xml: withValidCdc });
    expect(second).toMatchObject({ created: false, events: [] });
    expect(second.document.id).toBe(first.document.id);
  });

  it('stores a non-matching receiver as is_own_receiver=false without events', async () => {
    await seedProfile({ rucBase: '80000009', rucDv: 1 });
    const result = await useCase().execute({ tenantId, xml: withValidCdc });
    expect(result.document).toMatchObject({ status: 'confirmed', isOwnReceiver: false });
    expect(result.events).toEqual([]);
  });

  it('sends the untouched golden (placeholder CDC) to needs_review with reason codes', async () => {
    await seedProfile(MATCH);
    const result = await useCase().execute({ tenantId, xml: golden });
    expect(result.document.status).toBe('needs_review');
    expect(result.document.needsReviewReasons).toContain('cdc_check_digit_mismatch');
    expect(result.events).toEqual(['reception.document.needs_review']);
  });

  it('keeps garbage bytes stored and records extraction_failed', async () => {
    await seedProfile(MATCH);
    const result = await useCase().execute({ tenantId, xml: new TextEncoder().encode('nope') });
    expect(result.document.status).toBe('extraction_failed');
    const graph = await createDrizzleReceivedDocumentRepository(handle.db).load(
      tenantId,
      result.document.id,
    );
    expect(graph?.header.extractionErrorCode).toBe('malformed_xml.not_well_formed');
    expect(await storage.exists(graph?.artifact?.storageKey ?? '')).toBe(true);
  });
});
