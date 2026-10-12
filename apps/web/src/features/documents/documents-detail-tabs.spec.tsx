import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DocumentsDetail } from './documents-detail';
import { fakeDocumentsClient, ITEM } from './documents-fixtures';

const panel = () => screen.getByRole('region', { name: 'Detalle del comprobante' });

async function open() {
  const user = userEvent.setup();
  render(<DocumentsDetail documentId={ITEM.id} client={fakeDocumentsClient()} />);
  await within(panel()).findAllByRole('tab');
  return user;
}

describe('DocumentsDetail tabs', () => {
  it('shows three tabs with the KuDE selected by default', async () => {
    await open();

    const tabs = within(panel()).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Vista Gráfica KuDE',
      'XML Firmado <rDE>',
      'Eventos & Trazabilidad',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('moves between tabs with the arrow keys', async () => {
    const user = await open();

    await user.click(within(panel()).getByRole('tab', { name: /XML Firmado/ }));
    await user.keyboard('{ArrowRight}');
    expect(within(panel()).getByRole('tab', { name: /Eventos/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(within(panel()).getByRole('tab', { name: /Vista Gráfica/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
