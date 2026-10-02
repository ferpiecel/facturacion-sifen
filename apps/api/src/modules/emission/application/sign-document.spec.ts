import { beforeAll, describe, expect, it } from 'vitest';
import type { QrGenerator } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } from '@sifen/sifen-tips';
import { generateDevCertificate } from '../../../../test/support/dev-certificate.js';
import { createEstablishment } from '../../fiscal-config/domain/establishment.js';
import { createExpeditionPoint } from '../../fiscal-config/domain/expedition-point.js';
import { createFiscalProfile } from '../../fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../../fiscal-config/domain/ruc.js';
import { createTimbrado } from '../../fiscal-config/domain/timbrado.js';
import {
  CertificateNotFoundError,
  CertificateValidityError,
} from '../../certificates/infrastructure/certificate-vault.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import { InvoiceQrError } from './invoice-qr.js';
import { generateInvoiceXml, type InvoiceXmlContext } from './invoice-xml.js';
import type {
  CertificateSource,
  CscSecret,
  CscSource,
  SignableDocument,
  SigningCertificate,
  SigningStore,
} from './ports/signing.port.js';
import {
  CscNotConfiguredError,
  DocumentEnvironmentMismatchError,
  DocumentNotFoundError,
  SignDocument,
  SigningMismatchError,
} from './sign-document.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CSC = 'ABCD0000000000000000000000000000';

const draft: InvoiceDraft = {
  receiver: { kind: 'named', isPublicEntity: false },
  operationType: 'B2B',
  items: [{ quantity: 2, unitPrice: 5000, vatRate: 10 }],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

const context: InvoiceXmlContext = {
  environment: 'test',
  issuer: createFiscalProfile({
    ruc: parseRuc('80000001-3'),
    legalName: 'Empresa Real SA',
    tradeName: 'Empresa Real',
    taxpayerType: 'persona_juridica',
    regimeCode: '8',
    economicActivities: [{ code: '1254', description: 'Desarrollo de Software' }],
  }),
  establishment: createEstablishment({
    code: '001',
    address: 'Calle Falsa',
    houseNumber: '123',
    departmentCode: 11,
    districtCode: '145',
    districtDescription: 'CIUDAD DEL ESTE',
    cityCode: '3432',
    cityDescription: 'PUERTO PTE.STROESSNER (MUNIC)',
  }),
  establishmentContact: { phone: '0973-000000', email: 'emisor@test.com', name: 'Casa Matriz' },
  point: createExpeditionPoint({ code: '001' }),
  timbrado: createTimbrado({ number: '12345678', validityStart: '2024-01-01' }),
  numbering: { documentNumber: '0000001', securityCode: '298398000' },
  issuedAt: new Date('2026-09-30T13:00:00Z'),
  receiver: {
    ruc: '80000002-7',
    name: 'Receptor Prueba SA',
    address: 'Avda Prueba',
    houseNumber: '100',
    districtCode: 143,
    districtDescription: 'DOMINGO MARTINEZ DE IRALA',
    cityCode: 3344,
    cityDescription: 'PASO ITA (INDIGENA)',
  },
  lines: [{ code: 'A-001', description: 'Servicio real uno', unitCode: 77 }],
};

const builder = new TipsDeXmlBuilder();
const signer = new TipsXmlSigner();
const qr = new TipsQrGenerator();

let cdc: string;
beforeAll(async () => {
  ({ cdc } = await generateInvoiceXml(builder, draft, context));
});

class FakeStore implements SigningStore {
  readonly signed: { documentId: string; signedXml: string; signedAt: Date }[] = [];
  /** What markSigned answers (false emulates a concurrent signer). */
  accept = true;

  constructor(private document: SignableDocument | null) {}

  load(): Promise<SignableDocument | null> {
    return Promise.resolve(this.document);
  }

  markSigned(
    _tenantId: string,
    documentId: string,
    signed: { signedXml: string; signedAt: Date },
  ): Promise<boolean> {
    if (!this.accept) return Promise.resolve(false);
    this.signed.push({ documentId, ...signed });
    return Promise.resolve(true);
  }
}

const signable = (overrides: Partial<SignableDocument> = {}): SignableDocument => ({
  documentId: 'doc-1',
  cdc,
  status: 'accepted',
  environment: 'test',
  tenantEnvironment: 'test',
  draft,
  context,
  ...overrides,
});

function setup(
  options: {
    document?: SignableDocument | null;
    certificate?: () => Promise<SigningCertificate>;
    csc?: CscSecret | null;
    qrGenerator?: QrGenerator;
  } = {},
) {
  const dev = generateDevCertificate();
  const certificate: SigningCertificate = { p12: Buffer.from(dev.p12), password: dev.password };
  const csc = options.csc === undefined ? { idCsc: '0001', value: Buffer.from(CSC) } : options.csc;
  const store = new FakeStore(options.document === undefined ? signable() : options.document);
  const calls = { certificates: [] as string[], cscs: 0 };
  const certificates: CertificateSource = {
    open: (_tenantId, environment) => {
      calls.certificates.push(environment);
      return options.certificate ? options.certificate() : Promise.resolve(certificate);
    },
  };
  const cscs: CscSource = {
    get: () => {
      calls.cscs += 1;
      return Promise.resolve(csc);
    },
  };
  const service = new SignDocument({
    store,
    certificates,
    cscs,
    builder,
    signer,
    qr: options.qrGenerator ?? qr,
  });
  return { service, store, certificate, csc, calls };
}

const run = (service: SignDocument) => service.execute({ tenantId: TENANT, documentId: 'doc-1' });
const isZeroed = (buffer: Buffer | undefined) => buffer?.every((byte) => byte === 0) === true;

/** Spec: HU-E6-02 (S4a). Signing an accepted document with the tenant's certificate and CSC. */
describe('SignDocument', () => {
  it('builds, signs, adds the QR and stores a strictly valid XML with its signing instant', async () => {
    const { service, store } = setup();

    const result = await run(service);

    expect(result).toMatchObject({ status: 'signed', cdc });
    expect(store.signed).toHaveLength(1);
    const [stored] = store.signed;
    expect(validateXml(stored.signedXml, 'siRecepDE')).toEqual({ valid: true, errors: [] });
    expect(stored.signedXml).toContain('<Signature');
    expect(stored.signedXml).toContain('<dCarQR>');
    expect(stored.signedXml).not.toContain(CSC);
    expect(stored.signedAt.getTime()).toBe((result as { signedAt: Date }).signedAt.getTime());
    expect(Math.abs(stored.signedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('opens the certificate for the document environment', async () => {
    const { service, calls } = setup();
    await run(service);
    expect(calls.certificates).toEqual(['test']);
  });

  it('does nothing for a document that is not accepted', async () => {
    const { service, store, calls } = setup({ document: signable({ status: 'signed' }) });
    expect(await run(service)).toEqual({ status: 'skipped', documentStatus: 'signed' });
    expect(calls.certificates).toEqual([]);
    expect(calls.cscs).toBe(0);
    expect(store.signed).toEqual([]);
  });

  it('fails for an unknown document', async () => {
    const { service } = setup({ document: null });
    await expect(run(service)).rejects.toThrow(DocumentNotFoundError);
  });

  it('refuses a document of another environment before opening any secret', async () => {
    const { service, calls, store } = setup({
      document: signable({ environment: 'test', tenantEnvironment: 'production' }),
    });
    await expect(run(service)).rejects.toThrow(DocumentEnvironmentMismatchError);
    expect(calls.certificates).toEqual([]);
    expect(store.signed).toEqual([]);
  });

  it.each([
    ['no certificate', () => Promise.reject(new CertificateNotFoundError('test'))],
    ['an expired certificate', () => Promise.reject(new CertificateValidityError('expired'))],
  ])('fails closed with %s: typed error, nothing stored, no CSC opened', async (_name, open) => {
    const { service, store, calls } = setup({ certificate: open });
    const error = await run(service).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(
      [CertificateNotFoundError, CertificateValidityError].some((t) => error instanceof t),
    ).toBe(true);
    expect(store.signed).toEqual([]);
    expect(calls.cscs).toBe(0);
  });

  it('fails closed without a CSC and zeroizes the certificate', async () => {
    const { service, store, certificate } = setup({ csc: null });
    await expect(run(service)).rejects.toThrow(CscNotConfiguredError);
    expect(store.signed).toEqual([]);
    expect(isZeroed(certificate.p12)).toBe(true);
  });

  it('zeroizes the certificate and the CSC after a success', async () => {
    const { service, certificate, csc } = setup();
    await run(service);
    expect(isZeroed(certificate.p12)).toBe(true);
    expect(isZeroed(csc?.value)).toBe(true);
  });

  it('zeroizes both secrets when a later step fails, and stores nothing', async () => {
    const noQr: QrGenerator = { addQr: (xml) => Promise.resolve(xml) };
    const { service, store, certificate, csc } = setup({ qrGenerator: noQr });
    await expect(run(service)).rejects.toThrow(InvoiceQrError);
    expect(store.signed).toEqual([]);
    expect(isZeroed(certificate.p12)).toBe(true);
    expect(isZeroed(csc?.value)).toBe(true);
  });

  it('refuses to store an XML whose CDC differs from the document', async () => {
    const { service, store } = setup({ document: signable({ cdc: '1'.repeat(44) }) });
    await expect(run(service)).rejects.toThrow(SigningMismatchError);
    expect(store.signed).toEqual([]);
  });

  it('reports skipped when a concurrent signer won', async () => {
    const { service, store } = setup();
    store.accept = false;
    expect(await run(service)).toEqual({ status: 'skipped', documentStatus: 'signed' });
  });
});
