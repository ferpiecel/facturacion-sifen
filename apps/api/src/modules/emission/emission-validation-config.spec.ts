import { beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = { allowDecimals: true, unnamedThresholdPyg: 123 };
const SIGNING_SENTINEL = { ...SENTINEL, validateGeo: false };
const { createAcceptInvoice, signDocumentDeps } = vi.hoisted(() => ({
  createAcceptInvoice: vi.fn(() => vi.fn()),
  signDocumentDeps: [] as Record<string, unknown>[],
}));

vi.mock('./emission-validation-config.js', () => ({
  emissionValidationConfig: () => SENTINEL,
  signingValidationConfig: () => SIGNING_SENTINEL,
}));
vi.mock('./application/accept-invoice.js', () => ({ createAcceptInvoice }));
vi.mock('./application/sign-document.js', () => ({
  SignDocument: class {
    constructor(deps: Record<string, unknown>) {
      signDocumentDeps.push(deps);
    }
    execute = vi.fn();
  },
}));

import { createTenantCycleFactory } from '../../worker/tenant-cycle-factory.js';
import { acceptInvoiceFor } from './emission.module.js';

describe('single ValidationConfig source (HU-E5-09)', () => {
  beforeEach(() => {
    createAcceptInvoice.mockClear();
    signDocumentDeps.length = 0;
  });

  it('reads the API acceptance and the worker signing configs from this module (signing only skips the catalog checks)', () => {
    acceptInvoiceFor({} as never);
    createTenantCycleFactory({
      db: {} as never,
      gateway: {} as never,
      certificates: {} as never,
      cscs: {} as never,
    })('tenant-1');

    const calls = createAcceptInvoice.mock.calls as unknown as [{ validation: unknown }][];
    expect(calls[0][0].validation).toBe(SENTINEL);
    expect(signDocumentDeps[0].validation).toBe(SIGNING_SENTINEL);
  });
});
