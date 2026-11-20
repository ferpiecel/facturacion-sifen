import { cva } from 'class-variance-authority';

import { cn } from '../lib/cn';

export type DocumentStatus =
  | 'accepted'
  | 'signed'
  | 'queued'
  | 'submitted'
  | 'approved'
  | 'approved_with_observations'
  | 'rejected'
  | 'corrected'
  | 'number_voided'
  | 'cancelled'
  // Received documents (reception lifecycle).
  | 'received'
  | 'extracting'
  | 'extracted'
  | 'needs_review'
  | 'extraction_failed'
  | 'confirmed';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

// Pill with a leading dot, as in the Stitch "Estado DNIT" column.
const pill = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 font-label-sm text-label-sm font-semibold',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-container text-on-surface-variant',
        info: 'bg-tertiary-fixed text-on-tertiary-fixed-variant',
        success: 'bg-secondary-fixed/50 text-secondary',
        warning: 'bg-test-environment text-on-test-environment',
        danger: 'bg-error-container text-on-error-container',
      },
    },
  },
);

const dot = cva('size-1.5 shrink-0 rounded-full', {
  variants: {
    tone: {
      neutral: 'bg-outline',
      info: 'bg-tertiary',
      success: 'bg-secondary',
      warning: 'bg-test-environment-accent',
      danger: 'bg-error',
    },
  },
});

const STATUSES: Record<DocumentStatus, { label: string; tone: Tone }> = {
  accepted: { label: 'Recibido', tone: 'neutral' },
  signed: { label: 'Firmado', tone: 'info' },
  queued: { label: 'En cola', tone: 'info' },
  submitted: { label: 'Enviado a SIFEN', tone: 'info' },
  approved: { label: 'Aprobado SIFEN', tone: 'success' },
  approved_with_observations: { label: 'Aprobado con observación', tone: 'warning' },
  rejected: { label: 'Rechazado', tone: 'danger' },
  corrected: { label: 'Corregido', tone: 'neutral' },
  number_voided: { label: 'Número inutilizado', tone: 'neutral' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
  received: { label: 'Recibido', tone: 'neutral' },
  extracting: { label: 'Extrayendo datos', tone: 'info' },
  extracted: { label: 'Datos extraídos', tone: 'info' },
  needs_review: { label: 'Requiere revisión', tone: 'warning' },
  extraction_failed: { label: 'Extracción fallida', tone: 'danger' },
  confirmed: { label: 'Confirmado', tone: 'success' },
};

const UNKNOWN = { label: 'Desconocido', tone: 'neutral' } as const;

function isDocumentStatus(status: string): status is DocumentStatus {
  return Object.hasOwn(STATUSES, status);
}

interface StatusBadgeProps {
  /** SIFEN lifecycle state; unrecognised values render as "Desconocido". */
  status: string;
  className?: string;
}

/** SIFEN document or received-document state. The text label carries the meaning; color only reinforces it. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const { label, tone } = isDocumentStatus(status) ? STATUSES[status] : UNKNOWN;

  return (
    <span data-tone={tone} className={cn(pill({ tone }), className)}>
      <span aria-hidden="true" className={dot({ tone })} />
      {label}
    </span>
  );
}
