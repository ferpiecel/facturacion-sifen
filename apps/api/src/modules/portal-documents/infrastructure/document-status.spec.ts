import { DOCUMENT_STATUSES } from '@sifen/db';
import { describe, expect, it } from 'vitest';
import { PORTAL_DOCUMENT_STATUSES } from '../domain/document-status.js';

describe('PORTAL_DOCUMENT_STATUSES', () => {
  it('lists exactly the statuses the database accepts', () => {
    expect([...PORTAL_DOCUMENT_STATUSES]).toEqual([...DOCUMENT_STATUSES]);
  });
});
