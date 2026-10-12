'use client';

import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Hourglass,
  ReceiptText,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';

import { MoneyPYG } from '../../design-system/components/money-pyg';
import { formatInteger as integer, formatIssuedAt, formatPercent as percent } from './format';
import { summaryClient, type PeriodSummary, type SummaryClient } from './summary-client';
import {
  approvedStats,
  growthPct,
  PERIOD_OPTIONS,
  rejectionRatePct,
  type PeriodDays,
} from './summary-metrics';
import { useSummary } from './use-summary';

const CARD =
  'relative flex flex-col justify-between overflow-hidden rounded-xl bg-surface-container-lowest p-4 shadow-sm';
const LABEL = 'font-label-md text-label-md font-medium text-on-surface-variant';
const VALUE = 'font-headline-lg text-headline-lg font-bold text-on-surface';
const ICON = 'flex size-8 items-center justify-center rounded-lg';

const NOTE = 'font-label-sm text-label-sm text-outline';

function Growth({ count, previous }: { count: number; previous: number }) {
  const growth = growthPct(count, previous);
  if (growth === null) return <span className={NOTE}>Sin período previo para comparar</span>;
  const Arrow = growth < 0 ? ArrowDown : ArrowUp;
  return (
    <span
      className={`flex items-center font-code-sm text-code-sm font-semibold ${growth < 0 ? 'text-error' : 'text-secondary'}`}
    >
      <Arrow aria-hidden="true" className="size-3.5" />
      {`${growth < 0 ? '' : '+'}${percent(growth)}`}
    </span>
  );
}

function Indicators({ summary: s, days }: { summary: PeriodSummary; days: PeriodDays }) {
  const approved = approvedStats(s);
  const rate = rejectionRatePct(s);
  const { pending, rejected, totals } = s;
  return (
    <>
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={LABEL}>{`Emitidos (últimos ${String(days)} días)`}</span>
          <div className={`${ICON} bg-primary/10 text-primary`}>
            <ReceiptText aria-hidden="true" className="size-[18px]" />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <span className={VALUE}>{integer(totals.count)}</span>
          <Growth count={totals.count} previous={s.previous.count} />
        </div>
        <div className="mt-3 flex flex-col gap-0.5 font-label-sm text-label-sm text-outline">
          <MoneyPYG amount={Number(totals.amountPyg)} className="text-on-surface-variant" />
          {totals.otherCurrencyCount > 0 && (
            <span>{`${integer(totals.otherCurrencyCount)} en otra moneda, fuera del monto`}</span>
          )}
        </div>
      </div>
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={LABEL}>Aprobados por SIFEN</span>
          <div className={`${ICON} bg-secondary/10 text-secondary`}>
            <BadgeCheck aria-hidden="true" className="size-[18px]" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className={VALUE}>{integer(approved.count)}</span>
          {approved.pct === null ? (
            <span className={NOTE}>Sin comprobantes</span>
          ) : (
            <span className="rounded-full bg-secondary-fixed px-2 py-0.5 font-code-sm text-code-sm font-bold text-on-secondary-fixed">
              {`${percent(approved.pct)} del total`}
            </span>
          )}
        </div>
        <div
          role="progressbar"
          aria-label="Aprobados por SIFEN"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Number((approved.pct ?? 0).toFixed(1))}
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high"
        >
          <div
            className="h-full rounded-full bg-secondary"
            style={{ width: `${(approved.pct ?? 0).toFixed(1)}%` }}
          />
        </div>
      </div>
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={LABEL}>Pendientes de SIFEN</span>
          <div className={`${ICON} bg-tertiary/10 text-tertiary`}>
            <Hourglass aria-hidden="true" className="size-[18px]" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className={VALUE}>{integer(pending.count)}</span>
          <span className="font-code-sm text-code-sm font-medium text-tertiary">en proceso</span>
        </div>
        <div className="mt-3 flex flex-col gap-0.5 font-label-sm text-label-sm text-on-surface-variant">
          {pending.count === 0 ? (
            <span>Sin pendientes</span>
          ) : (
            <>
              {pending.overdue > 0 && (
                <span className="font-semibold text-error">{`${integer(pending.overdue)} vencidos (72 h)`}</span>
              )}
              {pending.dueSoon > 0 && <span>{`${integer(pending.dueSoon)} por vencer`}</span>}
              {pending.oldestDeadline && (
                <span className="text-outline">{`Vence primero: ${formatIssuedAt(pending.oldestDeadline)}`}</span>
              )}
            </>
          )}
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
            {integer(rejected.count)}
          </span>
          {rate !== null && (
            <span className="font-code-sm text-code-sm text-outline">{`${percent(rate)} tasa de rechazo`}</span>
          )}
        </div>
        <p className="mt-2.5 font-label-sm text-label-sm text-on-surface-variant">
          {rejected.topCodes.length === 0
            ? 'Sin rechazos'
            : `Motivos: ${rejected.topCodes.map(({ code, count }) => `${code} (${integer(count)})`).join(' · ')}`}
        </p>
      </div>
    </>
  );
}

/** Period indicators (HU-E12-03) from `GET /portal/summary`; the period is the last 7, 30 or 90 days. */
export function DocumentsKpis({ client = summaryClient }: { client?: SummaryClient }) {
  const [days, setDays] = useState<PeriodDays>(30);
  const { state, previous, retry } = useSummary(client, days);
  const shown = state ?? previous;
  const loading = state === undefined;

  return (
    <section
      aria-label="Indicadores del período"
      aria-busy={loading}
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <div
        role="group"
        aria-label="Período"
        className="flex items-center gap-1 sm:col-span-2 lg:col-span-4"
      >
        {PERIOD_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === days}
            onClick={() => {
              setDays(option);
            }}
            className={`rounded-full px-3 py-1 font-label-sm text-label-sm font-semibold ${option === days ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'}`}
          >{`${String(option)} días`}</button>
        ))}
      </div>
      {shown?.kind === 'ok' ? (
        <Indicators summary={shown.summary} days={days} />
      ) : shown ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl bg-error-container p-4 text-on-error-container sm:col-span-2 lg:col-span-4"
        >
          <span>No pudimos cargar los indicadores del período.</span>
          <button
            type="button"
            onClick={retry}
            className="rounded px-3 py-1 font-label-md text-label-md font-semibold underline"
          >
            Reintentar
          </button>
        </div>
      ) : (
        <p
          role="status"
          aria-label="Cargando indicadores"
          className="text-outline sm:col-span-2 lg:col-span-4"
        >
          Cargando indicadores…
        </p>
      )}
    </section>
  );
}
