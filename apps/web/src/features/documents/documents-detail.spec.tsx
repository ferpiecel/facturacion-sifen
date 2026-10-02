import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DocumentsBrowser } from './documents-browser';

const panel = () => screen.getByRole('region', { name: 'Detalle del comprobante' });

describe('DocumentsBrowser (detail panel and KuDE preview)', () => {
  it('opens the first approved document with its signature metadata', () => {
    render(<DocumentsBrowser />);

    expect(
      within(panel()).getByRole('heading', { level: 2, name: 'FE 001-001-0004520' }),
    ).toBeInTheDocument();
    expect(within(panel()).getByText('SIFEN v150 OK')).toBeInTheDocument();
    expect(within(panel()).getByText('Certificado: ACME PARAGUAY S.A.')).toBeInTheDocument();
    expect(within(panel()).getByText('XMLDSig RSA-SHA256')).toBeInTheDocument();
    expect(within(panel()).queryByText(/PKCS/)).not.toBeInTheDocument();
  });

  it('previews the KuDE with issuer, timbrado, CDC and receiver', () => {
    render(<DocumentsBrowser />);

    const kude = within(panel());
    expect(kude.getByText('ACME PARAGUAY S.A.')).toBeInTheDocument();
    expect(kude.getByText('KuDE de Factura Electrónica')).toBeInTheDocument();
    expect(kude.getByText('RUC: 80012345-0')).toBeInTheDocument();
    expect(kude.getByText('12548900')).toBeInTheDocument();
    expect(kude.getByText('N° 001-001-0004520')).toBeInTheDocument();
    expect(kude.getByText('01800123450001001000452022026100214582139077')).toBeInTheDocument();
    expect(kude.getByText('TELECOMUNICACIONES DEL SUR S.A.')).toBeInTheDocument();
    expect(kude.getByText('80034567-3')).toBeInTheDocument();
    expect(kude.getByText('Crédito (30 días)')).toBeInTheDocument();
  });

  it('lists the items and settles the IVA included in the total', () => {
    render(<DocumentsBrowser />);

    const kude = within(panel());
    expect(kude.getAllByRole('row')).toHaveLength(3);
    expect(kude.getByText('₲ 14.636.364')).toBeInTheDocument();
    expect(kude.getByText('₲ 1.463.636')).toBeInTheDocument();
    expect(kude.getByText('₲ 16.100.000')).toBeInTheDocument();
    expect(kude.getByText('Son: Dieciséis millones cien mil guaraníes')).toBeInTheDocument();
    expect(kude.getByText('SIFEN VALIDADO')).toBeInTheDocument();
  });

  it('offers the KuDE actions without WhatsApp, which the MVP does not include', () => {
    render(<DocumentsBrowser />);

    const kude = within(panel());
    expect(kude.getByRole('button', { name: 'Imprimir PDF' })).toBeInTheDocument();
    expect(kude.getByRole('button', { name: 'A4 / Ticket POS' })).toBeInTheDocument();
    expect(kude.getByRole('button', { name: 'Enviar por email' })).toBeInTheDocument();
    expect(kude.queryByText(/WhatsApp/)).not.toBeInTheDocument();
  });

  it('switches the panel and the current row when another KuDE is opened', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser />);

    const row = screen.getByRole('listitem', { name: 'FE 001-001-0004519' });
    await user.click(within(row).getByRole('button', { name: 'Ver KuDE' }));
    expect(within(panel()).getByRole('heading', { level: 2 })).toHaveTextContent(
      'FE 001-001-0004519',
    );
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('listitem', { name: 'FE 001-001-0004520' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('asks to pick a document when no approved one is visible', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'rejected');
    expect(
      within(panel()).getByText('Selecciona un comprobante aprobado para ver su KuDE.'),
    ).toBeInTheDocument();
  });
});
