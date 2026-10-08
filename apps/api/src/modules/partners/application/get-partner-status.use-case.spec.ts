import { describe, expect, it, vi } from 'vitest';
import {
  GetPartnerStatusUseCase,
  type TenantOperationalStatus,
} from './get-partner-status.use-case.js';
import type { PartnerStatusSource } from './partner-status-source.port.js';

const T1 = { id: 't1', name: 'Resto 1', environment: 'production' };
const T2 = { id: 't2', name: 'Resto 2', environment: 'test' };
const cert = (tenantId: string, status: string, notAfter: string, environment = 'production') => ({
  tenantId,
  environment,
  status,
  notAfter: new Date(notAfter),
});

function source(overrides: Partial<PartnerStatusSource> = {}): PartnerStatusSource {
  return {
    isMember: vi.fn(() => Promise.resolve(true)),
    read: vi.fn(() =>
      Promise.resolve({
        tenants: [T1, T2],
        certificates: [
          cert('t1', 'revoked', '2028-01-01T00:00:00Z'),
          cert('t1', 'active', '2027-06-30T00:00:00Z'),
          cert('t1', 'active', '2030-01-01T00:00:00Z', 'test'),
        ],
        documentCounts: [
          { tenantId: 't1', status: 'accepted', total: 2 },
          { tenantId: 't1', status: 'queued', total: 1 },
        ],
      }),
    ),
    ...overrides,
  };
}

describe('GetPartnerStatusUseCase', () => {
  it('returns null without reading anything when the user is not a member of the partner', async () => {
    const read = vi.fn();
    const port = source({ isMember: () => Promise.resolve(false), read });

    expect(await new GetPartnerStatusUseCase(port).execute('u', 'p')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('builds per-tenant status: the active certificate of the tenant environment and counts by status', async () => {
    const result = await new GetPartnerStatusUseCase(source()).execute('u', 'p');

    expect(result).toEqual([
      {
        tenantId: 't1',
        name: 'Resto 1',
        environment: 'production',
        certificate: { status: 'active', expiresAt: '2027-06-30T00:00:00.000Z' },
        documentsByStatus: { accepted: 2, queued: 1 },
      },
      {
        tenantId: 't2',
        name: 'Resto 2',
        environment: 'test',
        certificate: null,
        documentsByStatus: {},
      },
    ]);
  });

  it('falls back to the latest certificate when none is active, and never exposes document content', async () => {
    const port = source({
      read: vi.fn(() =>
        Promise.resolve({
          tenants: [T1],
          certificates: [
            cert('t1', 'revoked', '2026-01-01T00:00:00Z'),
            cert('t1', 'revoked', '2027-01-01T00:00:00Z'),
          ],
          documentCounts: [],
        }),
      ),
    });

    const result = (await new GetPartnerStatusUseCase(port).execute(
      'u',
      'p',
    )) as TenantOperationalStatus[];
    const [status] = result;

    expect(status.certificate).toEqual({
      status: 'revoked',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(Object.keys(status).sort()).toEqual([
      'certificate',
      'documentsByStatus',
      'environment',
      'name',
      'tenantId',
    ]);
  });
});
