import { cva } from 'class-variance-authority';

import { cn } from '../lib/cn';

export type DocumentStatus =
  | 'borrador'
  | 'firmado'
  | 'en_lote'
  | 'aprobado'
  | 'aprobado_con_observacion'
  | 'rechazado'
  | 'cancelado'
  | 'inutilizado';

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
  borrador: { label: 'Borrador', tone: 'neutral' },
  firmado: { label: 'Firmado', tone: 'info' },
  en_lote: { label: 'En lote', tone: 'info' },
  aprobado: { label: 'Aprobado SIFEN', tone: 'success' },
  aprobado_con_observacion: { label: 'Aprobado con observación', tone: 'warning' },
  rechazado: { label: 'Rechazado', tone: 'danger' },
  cancelado: { label: 'Cancelado', tone: 'neutral' },
  inutilizado: { label: 'Inutilizado', tone: 'neutral' },
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

/** SIFEN document state. The text label carries the meaning; color only reinforces it. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const { label, tone } = isDocumentStatus(status) ? STATUSES[status] : UNKNOWN;

  return (
    <span data-tone={tone} className={cn(pill({ tone }), className)}>
      <span aria-hidden="true" className={dot({ tone })} />
      {label}
    </span>
  );
}
