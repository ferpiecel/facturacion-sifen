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

/** Lifecycle states the portal knows; the API takes one `status` value. Unknown ones are never offered. */
export const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'borrador', label: 'Borrador' },
  { value: 'firmado', label: 'Firmado' },
  { value: 'en_lote', label: 'En lote' },
  { value: 'aprobado', label: 'Aprobado SIFEN' },
  { value: 'aprobado_con_observacion', label: 'Aprobado con observación' },
  { value: 'rechazado', label: 'Rechazado' },
  { value: 'cancelado', label: 'Cancelado' },
  { value: 'inutilizado', label: 'Inutilizado' },
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
