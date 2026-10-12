import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { DocumentItem } from './documents-client';
import { ITEM, NOTE, REJECTED } from './documents-fixtures';
import { DocumentsRow } from './documents-row';

function show(doc: DocumentItem, props: { selected?: boolean; current?: boolean } = {}) {
  const onOpen = vi.fn();
  const onToggle = vi.fn();
  render(
    <ul>
      <DocumentsRow
        doc={doc}
        selected={false}
        current={false}
        {...props}
        onOpen={onOpen}
        onToggle={onToggle}
      />
    </ul>,
  );
  return { row: screen.getByRole('listitem'), onOpen, onToggle };
}

describe('DocumentsRow', () => {
  it('shows number, status, receiver, RUC, issue time and total of an approved invoice', () => {
    const { row } = show(ITEM);

    expect(row).toHaveAccessibleName('FE 001-001-0004520');
    expect(within(row).getByText('Aprobado SIFEN')).toBeInTheDocument();
    expect(within(row).getByText('TELECOMUNICACIONES DEL SUR S.A.')).toBeInTheDocument();
    expect(within(row).getByText('RUC: 80034567-3')).toBeInTheDocument();
    expect(within(row).getByText('₲ 16.100.000')).toBeInTheDocument();
    expect(within(row).getByText('Emitido 02/10/2026 15:42')).toBeInTheDocument();
    expect(within(row).queryByText('Con observaciones')).not.toBeInTheDocument();
  });

  it('shows a credit note as a negative amount with its kind pill and observations', () => {
    const { row } = show(NOTE);

    expect(within(row).getByText('Nota de Crédito')).toBeInTheDocument();
    expect(within(row).getByText('-₲ 850.000')).toHaveClass('text-error');
    expect(within(row).getByText('Con observaciones')).toBeInTheDocument();
  });

  it('marks a rejected document and omits the RUC of an unnamed receiver', () => {
    const { row } = show(REJECTED);

    expect(within(row).getByText('Rechazado')).toBeInTheDocument();
    expect(within(row).getByText('Innominado')).toBeInTheDocument();
    expect(within(row).queryByText(/RUC:/)).not.toBeInTheDocument();
  });

  it('shows an amount in another currency as the API sent it', () => {
    const { row } = show({ ...ITEM, total: '120.50', currency: 'USD' });

    expect(within(row).getByText('120.50 USD')).toBeInTheDocument();
  });

  it('shows a neutral label for a SIFEN type the portal has no code for', () => {
    const { row } = show({ ...ITEM, type: null });

    expect(row).toHaveAccessibleName('Documento 001-001-0004520');
  });

  it('opens the detail and toggles the selection', async () => {
    const user = userEvent.setup();
    const { row, onOpen, onToggle } = show(ITEM, { current: true });

    expect(row).toHaveAttribute('aria-current', 'true');
    await user.click(within(row).getByRole('button', { name: 'Ver detalle' }));
    await user.click(within(row).getByRole('checkbox', { name: 'Seleccionar FE 001-001-0004520' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
