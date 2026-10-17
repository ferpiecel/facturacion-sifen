import { vi } from 'vitest';

import type { AttentionClient, AttentionPage, AttentionResult } from './attention-client';

export const ATTENTION: AttentionPage = {
  total: 3,
  truncated: false,
  items: [
    {
      id: 'd1',
      cdc: '01800123450001001000481222026092911789423585',
      type: 'FE',
      number: '001-001-0004812',
      issuedAt: '2026-10-10T15:00:00.000Z',
      receiverName: 'Itaú Paraguay S.A.',
      receiverRuc: '80003214-5',
      total: '12850000',
      currency: 'PYG',
      status: 'signed',
      hasObservations: false,
      reasons: ['overdue'],
      deadline: '2026-10-13T15:00:00.000Z',
      hoursRemaining: 0,
      hold: null,
      rejectionReason: null,
    },
    {
      id: 'd2',
      cdc: '01800123450001001000481122026092911789423593',
      type: 'FE',
      number: '001-001-0004811',
      issuedAt: '2026-10-11T15:00:00.000Z',
      receiverName: 'Retail S.A.',
      receiverRuc: null,
      total: '3420000',
      currency: 'PYG',
      status: 'rejected',
      hasObservations: false,
      reasons: ['rejected'],
      deadline: '2026-10-14T15:00:00.000Z',
      hoursRemaining: 20.5,
      hold: null,
      rejectionReason: 'RUC del receptor inexistente',
    },
    {
      id: 'd3',
      cdc: '01800123450001001000481022026092911789423601',
      type: 'NCE',
      number: '001-001-0000319',
      issuedAt: '2026-10-12T15:00:00.000Z',
      receiverName: 'Marta Benítez',
      receiverRuc: null,
      total: '650000',
      currency: 'PYG',
      status: 'accepted',
      hasObservations: false,
      reasons: ['held'],
      deadline: null,
      hoursRemaining: null,
      hold: 'signing:SigningDataIncompleteError',
      rejectionReason: null,
    },
  ],
};

export const fakeAttentionClient = (
  result: AttentionResult = { kind: 'ok', page: ATTENTION },
): AttentionClient & { get: ReturnType<typeof vi.fn> } => ({
  get: vi.fn(() => Promise.resolve(result)),
});
