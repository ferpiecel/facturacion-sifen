import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DocumentsBrowser } from './documents-browser';
import { SAMPLE_DOCUMENTS_PAGE } from './sample-documents';

function rowOf(number: string) {
  return screen.getByRole('listitem', { name: number });
}

describe('DocumentsBrowser (document list)', () => {
  it('lists the documents of the page, one row each', () => {
    render(<DocumentsBrowser />);

    const list = screen.getByRole('list', { name: 'Comprobantes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(SAMPLE_DOCUMENTS_PAGE.items.length);
    expect(within(rowOf('FE 001-001-0004520')).getByText('Aprobado SIFEN')).toBeInTheDocument();
  });

  it('shows every CDC as 44 valid digits through the CDC component', () => {
    render(<DocumentsBrowser />);

    for (const { cdc } of SAMPLE_DOCUMENTS_PAGE.items) expect(cdc).toMatch(/^\d{44}$/);
    expect(screen.getAllByRole('button', { name: 'Copiar CDC' })).toHaveLength(5);
  });
});
