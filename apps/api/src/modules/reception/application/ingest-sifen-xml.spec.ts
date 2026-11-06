import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeCdcCheckDigit } from '../../emission/domain/cdc.js';
import { computeRucCheckDigit } from '../../fiscal-config/domain/ruc.js';
import type { ReceivedDocument } from '../domain/received-document.js';
import { IngestSifenXml } from './ingest-sifen-xml.js';
import type {
  ArtifactMatch,
  CreateReceivedDocumentResult,
  NewReceivedArtifact,
  NewReceivedDocument,
  ReceivedDocumentRepository,
} from './ports/received-document-repository.port.js';
import {
  MalformedSifenXmlError,
  SifenXmlTooLargeError,
  UnsupportedDocumentTypeError,
  type ParsedSifenDocument,
  type SifenXmlParser,
} from './ports/sifen-xml-parser.port.js';
import type { StorageProvider } from './ports/storage-provider.port.js';
import type { TenantFiscalIdentity } from './ports/tenant-fiscal-identity.port.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-11-06T12:00:00.000Z');
const ISSUER_BASE = '80000000';
const RECEIVER_BASE = '80000001';
const RECEIVER_DV = computeRucCheckDigit(RECEIVER_BASE);

const cdcBody = '018000000000010010000001120261106100000000'.padEnd(43, '1');
const CDC = `${cdcBody}${String(computeCdcCheckDigit(cdcBody))}`;

function parsedDoc(over: Partial<ParsedSifenDocument> = {}): ParsedSifenDocument {
  return {
    cdc: CDC,
    documentType: 1,
    issuer: { ruc: ISSUER_BASE, dv: String(computeRucCheckDigit(ISSUER_BASE)), legalName: 'ACME' },
    receiver: { ruc: RECEIVER_BASE, dv: String(RECEIVER_DV), name: 'Cliente' },
    establishment: '001',
    expeditionPoint: '001',
    number: '0000001',
    documentNumber: '001-001-0000001',
    issueDate: '2026-11-06',
    currency: 'PYG',
    paymentCondition: 'cash',
    creditTermDays: null,
    totals: {
      exempt: '0',
      exonerated: '0',
      taxable5: '0',
      taxable10: '100000',
      vat5: '0',
      vat10: '10000',
      total: '110000',
    },
    items: [
      {
        description: 'Servicio',
        quantity: '1',
        unitPrice: '110000',
        discount: '0',
        taxRate: 10,
        taxBase: '100000',
        taxAmount: '10000',
        lineTotal: '110000',
      },
    ],
    authorizationProtocol: '123',
    ...over,
  };
}

/** Minimal fake: application specs must not import infrastructure adapters. */
class FakeStorage implements StorageProvider {
  readonly objects = new Map<string, Uint8Array>();
  constructor(private readonly log: string[]) {}
  upload(key: string, body: Uint8Array): Promise<void> {
    this.log.push('upload');
    this.objects.set(key, body.slice());
    return Promise.resolve();
  }
  download(key: string): Promise<Uint8Array> {
    return Promise.resolve(this.objects.get(key) ?? new Uint8Array());
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }
  presignedUrl(key: string): Promise<string> {
    return Promise.resolve(key);
  }
  ping(): Promise<void> {
    return Promise.resolve();
  }
}

class Harness {
  readonly log: string[] = [];
  readonly storage = new FakeStorage(this.log);
  readonly created: NewReceivedDocument[] = [];
  readonly documents = new Map<string, ReceivedDocument>();
  artifactMatch: ArtifactMatch | null = null;
  parseResult: ParsedSifenDocument | Error = parsedDoc();
  identity: { rucBase: string; dv: number } | null = { rucBase: RECEIVER_BASE, dv: RECEIVER_DV };
  private seq = 0;

  /** The single `create` input; fails loudly when nothing was persisted. */
  get first(): NewReceivedDocument {
    const input = this.created.at(0);
    if (input === undefined) throw new Error('nothing was created');
    return input;
  }

  readonly repository: ReceivedDocumentRepository = {
    create: (_tenantId, input): Promise<CreateReceivedDocumentResult> => {
      this.log.push('create');
      this.created.push(input);
      this.documents.set(input.header?.cdc ?? input.document.id, input.document);
      return Promise.resolve({ created: true, document: input.document });
    },
    load: () => Promise.reject(new Error('unused')),
    findByCdc: (_tenantId, cdc) => {
      this.log.push('findByCdc');
      return Promise.resolve(this.documents.get(cdc) ?? null);
    },
    findArtifactBySha256: () => {
      this.log.push('findArtifact');
      return Promise.resolve(this.artifactMatch);
    },
    save: () => Promise.reject(new Error('unused')),
  };

  readonly parser: SifenXmlParser = {
    parse: () => {
      this.log.push('parse');
      if (this.parseResult instanceof Error) throw this.parseResult;
      return this.parseResult;
    },
  };

  readonly fiscalIdentity: TenantFiscalIdentity = {
    getRucIdentity: () => Promise.resolve(this.identity),
  };

  readonly useCase = new IngestSifenXml({
    repository: this.repository,
    storage: this.storage,
    parser: this.parser,
    fiscalIdentity: this.fiscalIdentity,
    now: () => AT,
    newId: () => `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`,
  });
}

const XML = new TextEncoder().encode('<rDE/>');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const run = (h: Harness, xml = XML) => h.useCase.execute({ tenantId: TENANT, xml });

/** Spec: reception R3.3. */
describe('IngestSifenXml', () => {
  it('stores the artifact in a tenant-scoped key before parsing', async () => {
    const h = new Harness();
    await run(h);
    expect(h.log.indexOf('upload')).toBeGreaterThanOrEqual(0);
    expect(h.log.indexOf('upload')).toBeLessThan(h.log.indexOf('parse'));
    const key = h.first.artifact?.storageKey ?? '';
    expect(key.startsWith(`tenants/${TENANT}/`)).toBe(true);
    expect(await h.storage.exists(key)).toBe(true);
    expect(h.first.artifact?.sha256).toBe(sha(XML));
  });

  it('returns the existing document with created=false and writes nothing on a known sha256', async () => {
    const h = new Harness();
    const first = await run(h);
    h.artifactMatch = {
      artifact: { id: 'a', ...(h.first.artifact as NewReceivedArtifact) },
      document: first.document,
    };
    h.log.length = 0;
    const second = await run(h);
    expect(second).toEqual({ created: false, document: first.document, events: [] });
    expect(h.log).toEqual(['findArtifact']);
  });

  it('keeps the artifact stored and records extraction_failed when parsing fails', async () => {
    for (const error of [
      new MalformedSifenXmlError('not_well_formed'),
      new UnsupportedDocumentTypeError(4),
      new SifenXmlTooLargeError(10, 5),
    ]) {
      const h = new Harness();
      h.parseResult = error;
      const result = await run(h);
      const key = h.first.artifact?.storageKey ?? '';
      expect(await h.storage.exists(key)).toBe(true);
      expect(result.created).toBe(true);
      expect(result.document.status).toBe('extraction_failed');
      expect(result.document.version).toBe(1);
      expect(result.events).toEqual(['reception.document.extraction_failed']);
      expect(h.first.header?.extractionErrorCode).toMatch(/^[a-z0-9_.-]{1,64}$/);
    }
  });

  it('rethrows errors that are not the input fault, leaving the artifact stored', async () => {
    const h = new Harness();
    h.parseResult = new Error('boom');
    await expect(run(h)).rejects.toThrow('boom');
    expect(await h.storage.exists(`tenants/${TENANT}/received/sifen_xml/${sha(XML)}.xml`)).toBe(
      true,
    );
  });

  it('persists every field with confidence 1.0 and decimal-string money', async () => {
    const h = new Harness();
    await run(h);
    const input = h.first;
    expect(input.confidences?.length).toBe(8);
    expect(new Set(input.confidences?.map((c) => c.confidence))).toEqual(new Set(['1.0']));
    expect(input.document.confidenceOverall).toBe('1.0');
    expect(input.header?.totalAmount).toBe('110000');
    expect(input.header?.totalVat).toBe('10000');
    expect(input.header?.documentNumber).toBe('0000001');
    expect(input.items?.[0]).toMatchObject({ position: 1, subtotal: '110000', vatRate: 10 });
  });

  it('stores is_own_receiver=false and emits no event when the receiver is not the tenant', async () => {
    const h = new Harness();
    h.identity = { rucBase: '99999999', dv: 1 };
    const result = await run(h);
    expect(result.created).toBe(true);
    expect(result.document.isOwnReceiver).toBe(false);
    expect(result.document.status).toBe('confirmed');
    expect(result.events).toEqual([]);
  });

  it('treats a tenant without fiscal profile or a receiver without RUC as not own', async () => {
    const noProfile = new Harness();
    noProfile.identity = null;
    expect((await run(noProfile)).document.isOwnReceiver).toBe(false);

    const noRuc = new Harness();
    noRuc.parseResult = parsedDoc({ receiver: { ruc: null, dv: null, name: 'Innominado' } });
    const result = await run(noRuc);
    expect(result.document.isOwnReceiver).toBe(false);
    expect(result.events).toEqual([]);
  });

  it('ends confirmed at version 2 and emits the event for a matching receiver', async () => {
    const h = new Harness();
    const result = await run(h);
    expect(result.document).toMatchObject({
      status: 'confirmed',
      isOwnReceiver: true,
      version: 2,
      confirmedAt: AT,
    });
    expect(result.events).toEqual(['reception.document.confirmed']);
  });

  it('ends needs_review with the validation reason codes when validation fails', async () => {
    const h = new Harness();
    h.parseResult = parsedDoc({
      totals: { ...parsedDoc().totals, total: '999999' },
      cdc: `${CDC.slice(0, 43)}${String((Number(CDC[43]) + 1) % 10)}`,
    });
    const result = await run(h);
    expect(result.document.status).toBe('needs_review');
    expect(result.document.version).toBe(1);
    expect(result.document.needsReviewReasons).toEqual(
      expect.arrayContaining(['cdc_check_digit_mismatch', 'totals_blocks_sum_mismatch']),
    );
    expect(result.events).toEqual(['reception.document.needs_review']);
  });

  it('keeps needs_review silent for a mismatched receiver', async () => {
    const h = new Harness();
    h.identity = { rucBase: '99999999', dv: 1 };
    h.parseResult = parsedDoc({ totals: { ...parsedDoc().totals, total: '1' } });
    const result = await run(h);
    expect(result.document).toMatchObject({ status: 'needs_review', isOwnReceiver: false });
    expect(result.events).toEqual([]);
  });

  it('returns the existing document and drops the extra upload on a CDC duplicate with other bytes', async () => {
    const h = new Harness();
    const first = await run(h);
    const other = new TextEncoder().encode('<rDE>resigned</rDE>');
    h.log.length = 0;
    const again = await run(h, other);
    expect(again).toEqual({ created: false, document: first.document, events: [] });
    expect(h.log).not.toContain('create');
    expect(await h.storage.exists(`tenants/${TENANT}/received/sifen_xml/${sha(other)}.xml`)).toBe(
      false,
    );
    expect(await h.storage.exists(`tenants/${TENANT}/received/sifen_xml/${sha(XML)}.xml`)).toBe(
      true,
    );
  });
});
