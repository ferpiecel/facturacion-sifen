import type { KudeInvoice } from '../../domain/kude-model.js';

/** Renders the KuDE of an invoice; the output is a complete PDF document. */
export interface KudeRenderer {
  render(invoice: KudeInvoice): Promise<Uint8Array>;
}
