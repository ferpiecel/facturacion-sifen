import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DocumentsBrowser } from './documents-browser';

const panel = () => screen.getByRole('region', { name: 'Detalle del comprobante' });

async function open(name: RegExp) {
  const user = userEvent.setup();
  render(<DocumentsBrowser />);
  await user.click(within(panel()).getByRole('tab', { name }));
  return user;
}

describe('DocumentsBrowser (XML and events tabs)', () => {
  it('shows three tabs with the KuDE selected by default', () => {
    render(<DocumentsBrowser />);

    const tabs = within(panel()).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Vista Gráfica KuDE',
      'XML Firmado <rDE>',
      'Eventos & Trazabilidad',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(within(panel()).getByRole('tabpanel')).toHaveAccessibleName('Vista Gráfica KuDE');
  });

  it('shows the signed XML of the document with its CDC, parties and RSA-SHA256 signature', async () => {
    await open(/XML Firmado/);

    const xml = within(panel()).getByRole('tabpanel');
    expect(within(xml).getByText(/Payload XML oficial/)).toHaveTextContent('XMLDSig RSA-SHA256');
    const code = xml.querySelector('code')?.textContent ?? '';
    expect(code).toContain('<DE Id="01800123450001001000452022026100214582139077">');
    expect(code).toContain('<dVerFor>150</dVerFor>');
    expect(code).toContain('<dFeEmiDE>2026-10-02T15:42:00</dFeEmiDE>');
    expect(code).toContain('<dRucRec>80034567</dRucRec>');
    expect(code).toContain('<dDVRec>3</dDVRec>');
    expect(code).toContain('xmldsig-more#rsa-sha256');
    expect(xml).not.toHaveTextContent(/XAdES/);
  });

  it('lists the lifecycle events with the SIFEN approval code and no WhatsApp delivery', async () => {
    await open(/Eventos/);

    const events = within(panel()).getByRole('list', { name: 'Ciclo de vida del comprobante' });
    expect(within(events).getAllByRole('listitem')).toHaveLength(3);
    expect(within(events).getByText('15:42:01')).toBeInTheDocument();
    expect(within(events).getByText(/0260/)).toBeInTheDocument();
    expect(within(events).getByText(/facturacion@teledelsur\.com\.py/)).toBeInTheDocument();
    expect(within(panel()).queryByText(/WhatsApp/)).not.toBeInTheDocument();
  });

  it('offers cancellation with its 48 h window and no number voiding for an approved document', async () => {
    await open(/Eventos/);

    expect(within(panel()).getByRole('button', { name: 'Cancelar en SIFEN' })).toBeInTheDocument();
    expect(
      within(panel()).getByText(
        'Plazo de cancelación: hasta 04/10/2026 15:42 (48 h desde la aprobación)',
      ),
    ).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: /Inutilizar/ })).not.toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys', async () => {
    const user = await open(/XML Firmado/);

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
