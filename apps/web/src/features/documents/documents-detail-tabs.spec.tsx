import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsDetail } from './documents-detail';
import { DETAIL, fakeDocumentsClient, ITEM } from './documents-fixtures';

const panel = () => screen.getByRole('region', { name: 'Detalle del comprobante' });
let create = vi.fn(() => 'blob:kude');
let revoke = vi.fn();

beforeEach(() => {
  create = vi.fn(() => 'blob:kude');
  revoke = vi.fn();
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
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
    expect(within(events).getAllByRole('listitem')).toHaveLength(3);
    expect(within(events).getByText('Recibido')).toBeInTheDocument();
    expect(within(events).getByText('Firmado')).toBeInTheDocument();
    expect(within(events).getByText('Aprobado SIFEN')).toBeInTheDocument();
    expect(within(events).getAllByText('02/10/2026 15:42')).toHaveLength(3);
    expect(within(events).getByText(/0260.*Autorización del DE satisfactoria/)).toBeInTheDocument();
  });

  it('shows the rejection reason of a rejected document', async () => {
    const rejected = {
      ...DETAIL,
      status: 'rejected',
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

  it('hides the cancellation window for a type without a portal code', async () => {
    const nullType = { ...DETAIL, type: null };
    await open(
      /Eventos/,
      fakeDocumentsClient({
        detail: vi.fn(() => Promise.resolve({ kind: 'ok' as const, document: nullType })),
      }),
    );

    expect(
      within(panel()).queryByRole('button', { name: 'Cancelar en SIFEN' }),
    ).not.toBeInTheDocument();
    expect(within(panel()).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Documento 001-001-0004520',
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

  it('explains that the KuDE needs the document to be signed first (409)', async () => {
    const kude = vi.fn(() => Promise.resolve({ kind: 'not_signed' as const }));
    render(<DocumentsDetail documentId={ITEM.id} client={fakeDocumentsClient({ kude })} />);

    expect(
      await within(panel()).findByText(
        'El KuDE estará disponible cuando el comprobante esté firmado',
      ),
    ).toBeInTheDocument();
  });

  it('says the KuDE is not available for this document (422/501)', async () => {
    const kude = vi.fn(() => Promise.resolve({ kind: 'not_available' as const }));
    render(<DocumentsDetail documentId={ITEM.id} client={fakeDocumentsClient({ kude })} />);

    expect(
      await within(panel()).findByText('KuDE no disponible para este comprobante'),
    ).toBeInTheDocument();
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

  it('revokes the blob URL on unmount and when the document changes', async () => {
    const client = fakeDocumentsClient();
    const { unmount, rerender } = render(<DocumentsDetail documentId="a" client={client} />);
    await within(panel()).findByRole('link', { name: 'Descargar KuDE (PDF)' });

    rerender(<DocumentsDetail documentId="b" client={client} />);
    await within(panel()).findByRole('link', { name: 'Descargar KuDE (PDF)' });
    expect(revoke).toHaveBeenCalledWith('blob:kude');
    unmount();
    expect(revoke.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not create a blob URL for a response that arrives after unmount', async () => {
    let resolve: (value: { kind: 'ok'; pdf: Blob }) => void = () => undefined;
    const kude = vi.fn(() => new Promise<{ kind: 'ok'; pdf: Blob }>((r) => (resolve = r)));
    const { unmount } = render(
      <DocumentsDetail documentId="a" client={fakeDocumentsClient({ kude })} />,
    );
    await waitFor(() => {
      expect(kude).toHaveBeenCalled();
    });

    unmount();
    resolve({ kind: 'ok', pdf: new Blob(['%PDF']) });
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
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
