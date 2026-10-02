import {
  ArrowRight,
  ArrowUp,
  BadgeCheck,
  Hourglass,
  ReceiptText,
  TriangleAlert,
} from 'lucide-react';

import { SAMPLE_PERIOD_SUMMARY as S } from './sample-documents';

const CARD =
  'relative flex flex-col justify-between overflow-hidden rounded-xl bg-surface-container-lowest p-4 shadow-sm';
const LABEL = 'font-label-md text-label-md font-medium text-on-surface-variant';
const VALUE = 'font-headline-lg text-headline-lg font-bold text-on-surface';
const ICON = 'flex size-8 items-center justify-center rounded-lg';

const integer = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const percent = (value: number) => `${value.toFixed(1)}%`;

/** Period indicators (HU-E12-03): issued, approved, queued and rejected. */
export function DocumentsKpis() {
  return (
    <section
      aria-label="Indicadores del período"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={LABEL}>Emitidos (últimos 30 días)</span>
          <div className={`${ICON} bg-primary/10 text-primary`}>
            <ReceiptText aria-hidden="true" className="size-[18px]" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className={VALUE}>{integer(S.issued)}</span>
          <span className="flex items-center font-code-sm text-code-sm font-semibold text-secondary">
            <ArrowUp aria-hidden="true" className="size-3.5" />
            {`+${percent(S.issuedGrowthPct)}`}
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between font-label-sm text-label-sm text-outline">
          <span>{S.period}</span>
          <span>{`Meta: ${integer(S.goal)} DE`}</span>
        </div>
      </div>
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span id="kpi-approved" className={LABEL}>
            Aprobados por SIFEN
          </span>
          <div className={`${ICON} bg-secondary/10 text-secondary`}>
            <BadgeCheck aria-hidden="true" className="size-[18px]" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className={VALUE}>{integer(S.approved)}</span>
          <span className="rounded-full bg-secondary-fixed px-2 py-0.5 font-code-sm text-code-sm font-bold text-on-secondary-fixed">
            {`${percent(S.approvedPct)} del total`}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Aprobados por SIFEN"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={S.approvedPct}
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high"
        >
          <div className="h-full rounded-full bg-secondary" style={{ width: `%` }} />
        </div>
      </div>
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={LABEL}>En Cola / Sincronización</span>
          <div className={`${ICON} bg-tertiary/10 text-tertiary`}>
            <Hourglass aria-hidden="true" className="size-[18px]" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className={VALUE}>{integer(S.queued)}</span>
          <span className="font-code-sm text-code-sm font-medium text-tertiary">en proceso</span>
        </div>
        <div className="mt-3 flex items-center gap-1.5 font-label-sm text-label-sm text-on-surface-variant">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-tertiary motion-safe:animate-pulse"
          />
          <span>{`Demora media: ~${String(S.queueAvgLatencySeconds).replace('.', ',')} s por lote`}</span>
        </div>
      </div>
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={LABEL}>Rechazados / A Subsanar</span>
          <div className={`${ICON} bg-error-container text-error`}>
            <TriangleAlert aria-hidden="true" className="size-[18px]" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-headline-lg text-headline-lg font-bold text-error">
            {S.rejected}
          </span>
          <span className="font-code-sm text-code-sm text-outline">{`${percent(S.errorRatePct)} tasa error`}</span>
        </div>
        <button
          type="button"
          className="mt-2.5 flex items-center gap-1 text-left font-label-sm text-label-sm font-semibold text-primary hover:underline"
        >
          {`Ver motivos (${S.rejectionCodes.join(' / ')})`}
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </section>
  );
}
