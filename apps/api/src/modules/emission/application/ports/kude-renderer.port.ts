import type { KudeFormat, KudeInvoice } from '../../domain/kude-model.js';

/** Renders the KuDE of an invoice; the output is a complete PDF document. Default format: letter. */
export interface KudeRenderer {
  render(invoice: KudeInvoice, format?: KudeFormat): Promise<Uint8Array>;
}
