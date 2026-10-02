import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DocumentsBrowser } from './documents-browser';
import { SAMPLE_DOCUMENTS_PAGE } from './sample-documents';

function rowOf(number: string) {
  return screen.getByRole('listitem', { name: number });
}

describe('DocumentsBrowser (document list)', () => {
  it('lists the documents of the page, one row each, with number, receiver and total', () => {
    render(<DocumentsBrowser />);

    const list = screen.getByRole('list', { name: 'Comprobantes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(SAMPLE_DOCUMENTS_PAGE.items.length);
    const row = rowOf('FE 001-001-0004520');
    expect(within(row).getByText('Aprobado SIFEN')).toBeInTheDocument();
    expect(within(row).getByText('TELECOMUNICACIONES DEL SUR S.A.')).toBeInTheDocument();
    expect(within(row).getByText('RUC: 80034567-3')).toBeInTheDocument();
    expect(within(row).getByText('₲ 16.100.000')).toBeInTheDocument();
    expect(within(row).getByText('IVA 10%: ₲ 1.463.636')).toBeInTheDocument();
    expect(
      within(row).getByText(/Emitido 02\/10\/2026 15:42 • Timbrado N° 12548900/),
    ).toBeInTheDocument();
  });

  it('shows the credit note as a negative amount with its association and kind pill', () => {
    render(<DocumentsBrowser />);

    const row = rowOf('NCE 001-001-0000104');
    expect(within(row).getByText('Nota de Crédito')).toBeInTheDocument();
    expect(within(row).getByText('-₲ 850.000')).toHaveClass('text-error');
    expect(within(row).getByText(/Asociado a FE 001-001-0004490/)).toBeInTheDocument();
  });

  it('explains a rejected document with the SIFEN code and offers to correct it', () => {
    render(<DocumentsBrowser />);

    const row = rowOf('FE 001-001-0004518');
    expect(within(row).getByText('Rechazado')).toBeInTheDocument();
    expect(within(row).getByText(/Error 1321: Receptor innominado/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Corregir y re-emitir' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Ver KuDE' })).not.toBeInTheDocument();
  });

  it('shows a queued document with its batch and no downloads yet', () => {
    render(<DocumentsBrowser />);

    const row = rowOf('FE 002-001-0001188');
    expect(within(row).getByText('En lote')).toBeInTheDocument();
    expect(within(row).getByText('Lote #8921')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /KuDE|XML/ })).not.toBeInTheDocument();
  });

  it('shows every CDC as 44 valid digits through the CDC component', () => {
    render(<DocumentsBrowser />);

    for (const { cdc } of SAMPLE_DOCUMENTS_PAGE.items) expect(cdc).toMatch(/^\d{44}$/);
    expect(screen.getAllByRole('button', { name: 'Copiar CDC' })).toHaveLength(5);
  });
});
