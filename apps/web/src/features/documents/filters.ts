import type { DocumentStatus } from '../../design-system/components/status-badge';
import { ESTABLISHMENTS, type DocumentKind, type DocumentRow } from './sample-documents';

export type StatusGroup = 'approved' | 'queue' | 'rejected' | 'void';

export interface Filters {
  query: string;
  kind: DocumentKind | '';
  status: StatusGroup | '';
  establishment: string;
  onlyIssues: boolean;
}

export const NO_FILTERS: Filters = {
  query: '',
  kind: '',
  status: '',
  establishment: '',
  onlyIssues: false,
};

export const KIND_OPTIONS: readonly { value: DocumentKind; label: string }[] = [
  { value: 'FE', label: 'Facturas Electrónicas (FE)' },
  { value: 'NCE', label: 'Notas de Crédito (NCE)' },
  { value: 'NDE', label: 'Notas de Débito (NDE)' },
  { value: 'AFE', label: 'Autofacturas (AFE)' },
];

export const STATUS_OPTIONS: readonly {
  value: StatusGroup;
  label: string;
  statuses: readonly DocumentStatus[];
}[] = [
  { value: 'approved', label: 'Aprobado', statuses: ['aprobado', 'aprobado_con_observacion'] },
  { value: 'queue', label: 'En cola / Procesando', statuses: ['borrador', 'firmado', 'en_lote'] },
  { value: 'rejected', label: 'Rechazado', statuses: ['rechazado'] },
  { value: 'void', label: 'Inutilizado / Anulado', statuses: ['cancelado', 'inutilizado'] },
];

const digits = (text: string) => text.replace(/\D/g, '');

function matchesQuery(doc: DocumentRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const numeric = digits(needle);
  return (
    doc.receiver.name.toLowerCase().includes(needle) ||
    doc.number.includes(needle) ||
    (numeric !== '' && (doc.cdc.includes(numeric) || digits(doc.receiver.id).includes(numeric)))
  );
}

export function filterDocuments(rows: readonly DocumentRow[], filters: Filters): DocumentRow[] {
  const statuses = STATUS_OPTIONS.find(({ value }) => value === filters.status)?.statuses;
  return rows.filter(
    (doc) =>
      matchesQuery(doc, filters.query) &&
      (filters.kind === '' || doc.kind === filters.kind) &&
      (statuses === undefined || statuses.includes(doc.status)) &&
      (filters.establishment === '' || doc.establishment === filters.establishment) &&
      (!filters.onlyIssues ||
        doc.status === 'rechazado' ||
        doc.status === 'aprobado_con_observacion'),
  );
}

/** Active filters as removable chips (the search text has its own input). */
export function appliedFilters(filters: Filters): { key: keyof Filters; label: string }[] {
  const chips: { key: keyof Filters; label: string }[] = [];
  const kind = KIND_OPTIONS.find(({ value }) => value === filters.kind);
  if (kind) chips.push({ key: 'kind', label: kind.label });
  const status = STATUS_OPTIONS.find(({ value }) => value === filters.status);
  if (status) chips.push({ key: 'status', label: status.label });
  if (filters.establishment) {
    chips.push({
      key: 'establishment',
      label: `${ESTABLISHMENTS[filters.establishment] ?? ''} (${filters.establishment})`,
    });
  }
  if (filters.onlyIssues) chips.push({ key: 'onlyIssues', label: 'Con observaciones o rechazos' });
  return chips;
}
