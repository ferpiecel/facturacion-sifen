'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '../lib/cn';

const CDC_PATTERN = /^\d{44}$/;
// CDC layout: iTiDE, RUC, DV, establishment, point, number, taxpayer type,
// date, emission type, security code, check digit.
const FIELD_LENGTHS = [2, 8, 1, 3, 3, 7, 1, 8, 1, 9, 1] as const;

const COPY_FEEDBACK_MS = 2000;

type CopyState = 'idle' | 'copied' | 'failed';

const COPY_MESSAGES: Record<CopyState, string> = {
  idle: '',
  copied: 'CDC copiado',
  failed: 'No se pudo copiar el CDC',
};

interface CdcDisplayProps {
  /** Código de Control: 44 digits identifying an electronic document. */
  value: string;
  variant?: 'full' | 'truncated';
  className?: string;
}

function splitFields(value: string): string[] {
  let offset = 0;
  return FIELD_LENGTHS.map((length) => {
    const field = value.slice(offset, offset + length);
    offset += length;
    return field;
  });
}

/** Stitch table format: `01-80003214-5...890` (type, RUC, DV, last three digits). */
function truncate(value: string): string {
  return `${value.slice(0, 2)}-${value.slice(2, 10)}-${value.slice(10, 11)}...${value.slice(-3)}`;
}

/**
 * CDC chip ported from the Stitch table. In the full variant fields are
 * separated by spacing only, so selecting the text copies the exact value.
 */
export function CdcDisplay({ value, variant = 'full', className }: CdcDisplayProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      clearTimeout(resetTimer.current);
    },
    [],
  );

  if (!CDC_PATTERN.test(value)) {
    return (
      <span className={cn('inline-flex w-fit flex-col gap-0.5', className)}>
        <span className="break-all font-code-sm text-code-sm text-error">{value}</span>
        <span className="font-label-sm text-label-sm text-error">
          CDC inválido: debe tener 44 dígitos
        </span>
      </span>
    );
  }

  const copy = async () => {
    let next: CopyState = 'copied';
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      next = 'failed';
    }
    setCopyState(next);
    // Reset so the next copy changes the live region again and is announced.
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setCopyState('idle');
    }, COPY_FEEDBACK_MS);
  };

  return (
    <span
      className={cn(
        'group flex w-fit items-center gap-1.5 rounded bg-surface-container-low px-2 py-1',
        className,
      )}
    >
      {variant === 'truncated' ? (
        <span
          data-testid="cdc-value"
          title={value}
          className="font-code-sm text-code-sm text-on-surface-variant"
        >
          <span aria-hidden="true">{truncate(value)}</span>
          <span className="sr-only">{`CDC ${value}`}</span>
        </span>
      ) : (
        <span
          data-testid="cdc-value"
          className="flex flex-wrap gap-x-1 font-code-sm text-code-sm text-on-surface-variant"
        >
          {splitFields(value).map((field, index) => (
            <span key={index}>{field}</span>
          ))}
        </span>
      )}
      <button
        type="button"
        aria-label="Copiar CDC"
        onClick={() => void copy()}
        // 24x24px hit area (WCAG 2.5.8); negative margin keeps the Stitch layout.
        className="-m-1 inline-flex size-6 items-center justify-center rounded text-outline transition-colors group-hover:text-primary"
      >
        {copyState === 'copied' ? (
          <Check aria-hidden="true" className="size-3.5 text-secondary" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {COPY_MESSAGES[copyState]}
      </span>
    </span>
  );
}
