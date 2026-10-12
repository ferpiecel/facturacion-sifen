import type { DocumentKind } from './documents-client';

export interface Filters {
  q: string;
  type: DocumentKind | '';
  status: string;
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  to: string;
}

export const NO_FILTERS: Filters = { q: '', type: '', status: '', from: '', to: '' };

export const KIND_OPTIONS: readonly { value: DocumentKind; label: string }[] = [
  { value: 'FE', label: 'Facturas Electrónicas (FE)' },
  { value: 'NCE', label: 'Notas de Crédito (NCE)' },
  { value: 'NDE', label: 'Notas de Débito (NDE)' },
  { value: 'AFE', label: 'Autofacturas (AFE)' },
];

/** The API's lifecycle states (`PORTAL_DOCUMENT_STATUSES`); it takes one `status` value. */
export const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'accepted', label: 'Recibido' },
  { value: 'signed', label: 'Firmado' },
  { value: 'queued', label: 'En cola' },
  { value: 'submitted', label: 'Enviado a SIFEN' },
  { value: 'approved', label: 'Aprobado SIFEN' },
  { value: 'approved_with_observations', label: 'Aprobado con observación' },
  { value: 'rejected', label: 'Rechazado' },
  { value: 'corrected', label: 'Corregido' },
  { value: 'number_voided', label: 'Número inutilizado' },
  { value: 'cancelled', label: 'Cancelado' },
];

/** Active filters as removable chips (the date inputs and the search box have their own controls). */
export function appliedFilters(filters: Filters): { key: keyof Filters; label: string }[] {
  const chips: { key: keyof Filters; label: string }[] = [];
  const kind = KIND_OPTIONS.find(({ value }) => value === filters.type);
  if (kind) chips.push({ key: 'type', label: kind.label });
  const status = STATUS_OPTIONS.find(({ value }) => value === filters.status);
  if (status) chips.push({ key: 'status', label: status.label });
  if (filters.from) chips.push({ key: 'from', label: `Desde ${filters.from}` });
  if (filters.to) chips.push({ key: 'to', label: `Hasta ${filters.to}` });
  if (filters.q) chips.push({ key: 'q', label: `Búsqueda: ${filters.q}` });
  return chips;
}
