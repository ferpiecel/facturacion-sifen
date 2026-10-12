import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsDetail } from './documents-detail';
import { DETAIL, fakeDocumentsClient, ITEM } from './documents-fixtures';

const panel = () => screen.getByRole('region', { name: 'Detalle del comprobante' });
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:kude');
  URL.revokeObjectURL = vi.fn();
});

async function open(name: RegExp, client = fakeDocumentsClient()) {
  const user = userEvent.setup();
  render(<DocumentsDetail documentId={ITEM.id} client={client} />);
  await user.click(await within(panel()).findByRole('tab', { name }));
  return { user, client };
}

describe('DocumentsDetail tabs', () => {
  it('shows three tabs with the KuDE selected by default', async () => {
    render(<DocumentsDetail documentId={ITEM.id} client={fakeDocumentsClient()} />);

    const tabs = await within(panel()).findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Vista Gráfica KuDE',
      'XML Firmado <rDE>',
      'Eventos & Trazabilidad',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('lists the lifecycle events with status, SIFEN code and message', async () => {
    await open(/Eventos/);

    const events = within(panel()).getByRole('list', { name: 'Ciclo de vida del comprobante' });
    expect(within(events).getAllByRole('listitem')).toHaveLength(2);
    expect(within(events).getByText('Firmado')).toBeInTheDocument();
    expect(within(events).getByText('Aprobado SIFEN')).toBeInTheDocument();
    expect(within(events).getAllByText('02/10/2026 15:42')).toHaveLength(2);
    expect(within(events).getByText(/0260.*Autorización del DE satisfactoria/)).toBeInTheDocument();
  });

  it('shows the rejection reason of a rejected document', async () => {
    const rejected = {
      ...DETAIL,
      status: 'rechazado',
      rejectionReason: '1321: Receptor innominado no permitido',
    };
    await open(
      /Eventos/,
      fakeDocumentsClient({
        detail: vi.fn(() => Promise.resolve({ kind: 'ok' as const, document: rejected })),
      }),
    );

    expect(within(panel()).getByRole('alert')).toHaveTextContent('Motivo del rechazo');
    expect(within(panel()).getByRole('alert')).toHaveTextContent(
      '1321: Receptor innominado no permitido',
    );
  });

  it('keeps the cancellation window of the document type', async () => {
    await open(/Eventos/);

    expect(within(panel()).getByRole('button', { name: 'Cancelar en SIFEN' })).toBeInTheDocument();
    expect(
      within(panel()).getByText(
        'Plazo de cancelación: hasta 04/10/2026 15:42 (48 h desde la aprobación)',
      ),
    ).toBeInTheDocument();
  });

  it('offers the KuDE PDF as a download', async () => {
    const client = fakeDocumentsClient();
    render(<DocumentsDetail documentId={ITEM.id} client={client} />);

    const link = await within(panel()).findByRole('link', { name: 'Descargar KuDE (PDF)' });
    expect(link).toHaveAttribute('href', 'blob:kude');
    expect(link).toHaveAttribute('download', 'kude-001-001-0004520.pdf');
    expect(client.kude).toHaveBeenCalledWith(ITEM.id);
  });

  it('says the KuDE is not available yet on a 501', async () => {
    const kude = vi.fn(() => Promise.resolve({ kind: 'not_available' as const }));
    render(<DocumentsDetail documentId={ITEM.id} client={fakeDocumentsClient({ kude })} />);

    expect(await within(panel()).findByText('KuDE no disponible todavía')).toBeInTheDocument();
    expect(within(panel()).queryByRole('link', { name: /KuDE/ })).not.toBeInTheDocument();
  });

  it('reports a KuDE that could not be loaded and retries', async () => {
    const user = userEvent.setup();
    const kude = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'ok', pdf: new Blob(['%PDF']) });
    render(<DocumentsDetail documentId={ITEM.id} client={fakeDocumentsClient({ kude })} />);

    expect(await within(panel()).findByText('No pudimos cargar el KuDE.')).toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Reintentar' }));
    expect(
      await within(panel()).findByRole('link', { name: 'Descargar KuDE (PDF)' }),
    ).toBeInTheDocument();
  });

  it('shows the signed XML with a download link and copies it', async () => {
    const { user } = await open(/XML Firmado/);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

    const xml = await within(panel()).findByLabelText('XML firmado');
    expect(xml).toHaveTextContent('<rDE><DE Id="1"/></rDE>');
    expect(within(panel()).getByRole('link', { name: 'Descargar XML' })).toHaveAttribute(
      'href',
      `/api/portal/documents/${ITEM.id}/xml`,
    );
    await user.click(within(panel()).getByRole('button', { name: 'Copiar XML' }));
    expect(writeText).toHaveBeenCalledWith('<rDE><DE Id="1"/></rDE>');
  });

  it('says so when the XML does not exist yet', async () => {
    const xml = vi.fn(() => Promise.resolve({ kind: 'not_found' as const }));
    await open(/XML Firmado/, fakeDocumentsClient({ xml }));

    expect(
      await within(panel()).findByText('El XML todavía no está disponible.'),
    ).toBeInTheDocument();
  });

  it('offers to retry a failed XML load', async () => {
    const xml = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'ok', xml: '<rDE/>' });
    const { user } = await open(/XML Firmado/, fakeDocumentsClient({ xml }));

    await user.click(await within(panel()).findByRole('button', { name: 'Reintentar' }));
    expect(await within(panel()).findByLabelText('XML firmado')).toHaveTextContent('<rDE/>');
  });

  it('moves between tabs with the arrow keys', async () => {
    const { user } = await open(/XML Firmado/);

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
