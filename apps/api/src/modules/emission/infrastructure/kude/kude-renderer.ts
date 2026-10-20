import type { KudeRenderer } from '../../application/ports/kude-renderer.port.js';
import type { KudeFormat, KudeInvoice } from '../../domain/kude-model.js';
import { PdfkitKudeRenderer } from './pdfkit-kude-renderer.js';
import { PdfkitTicketKudeRenderer } from './pdfkit-ticket-kude-renderer.js';

/** Letter (A4) or paper roll layout by `format`; the FE/NCE letter output is unchanged. */
export function createKudeRenderer(): KudeRenderer {
  const letter = new PdfkitKudeRenderer();
  const ticket = new PdfkitTicketKudeRenderer();
  return {
    render: (invoice: KudeInvoice, format: KudeFormat = 'letter') =>
      format === 'letter' ? letter.render(invoice) : ticket.render(invoice, format),
  };
}
