'use client';

import {
  BadgeCheck,
  Banknote,
  ReceiptText,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';

import { MoneyPYG } from '../../design-system/components/money-pyg';
import { formatInteger as integer, formatPercent as percent } from '../documents/format';
import { summaryClient, type SummaryClient } from '../documents/summary-client';
import { approvedStats, growthPct } from '../documents/summary-metrics';
import { useSummary } from '../documents/use-summary';

const DAYS = 30;
const CARD =
  'relative flex flex-col justify-between overflow-hidden rounded-xl bg-surface-container-lowest p-space-md shadow-sm transition-shadow hover:shadow-md';
const KPI_LABEL = 'font-label-sm text-label-sm tracking-wide text-outline uppercase';
const KPI_VALUE = 'font-headline-xl text-headline-xl tracking-tight text-on-surface';
const KPI_ICON = 'flex size-10 items-center justify-center rounded-xl bg-surface-container-low';
const PILL =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-label-sm text-label-sm font-semibold';
const NOTE = 'font-label-sm text-label-sm text-outline';

function Card({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={CARD}>
      <div className="flex items-start justify-between">
        <span className={KPI_LABEL}>{label}</span>
        <div className={KPI_ICON}>{icon}</div>
      </div>
      {children}
    </div>
  );
}

/** Billing, issued, queue and rejected of the last 30 days, from `GET /portal/summary` (HU-E12-03). */
export function PanelKpis({ client = summaryClient }: { client?: SummaryClient }) {
  const { state: shown, retry } = useSummary(client, DAYS);

  if (shown?.kind !== 'ok') {
    return (
      <section aria-label="Indicadores" aria-busy={shown === undefined}>
        {shown ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl bg-error-container p-space-md text-on-error-container"
          >
            <span>No pudimos cargar los indicadores del período.</span>
            <button
              type="button"
              onClick={retry}
              className="font-label-md text-label-md font-semibold underline"
            >
              Reintentar
            </button>
          </div>
        ) : (
          <p role="status" aria-label="Cargando indicadores" className="text-outline">
            Cargando indicadores…
          </p>
        )}
      </section>
    );
  }

  const s = shown.summary;
  const growth = growthPct(s.totals.count, s.previous.count);
  const approved = approvedStats(s);
  const { pending } = s;
  return (
    <section
      aria-label="Indicadores"
      className="grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-4"
    >
      <Card
        label={`Facturación (${String(DAYS)} días)`}
        icon={<Banknote aria-hidden="true" className="size-[22px] text-primary" />}
      >
        <MoneyPYG amount={Number(s.totals.amountPyg)} className={`mt-1 ${KPI_VALUE}`} />
        {s.totals.otherCurrencyCount > 0 && (
          <span
            className={`mt-space-md ${NOTE}`}
          >{`${integer(s.totals.otherCurrencyCount)} en otra moneda, fuera del monto`}</span>
        )}
      </Card>
      <Card
        label="Comprobantes Emitidos"
        icon={<ReceiptText aria-hidden="true" className="size-[22px] text-secondary" />}
      >
        <span className={`mt-1 ${KPI_VALUE}`}>{integer(s.totals.count)}</span>
        <div className="mt-space-md flex flex-wrap items-center gap-2 pt-space-xs">
          {growth === null ? (
            <span className={NOTE}>Sin período previo para comparar</span>
          ) : (
            <span
              className={`${PILL} ${growth < 0 ? 'bg-error-container text-error' : 'bg-secondary-fixed/40 text-secondary'}`}
            >
              {growth < 0 ? (
                <TrendingDown aria-hidden="true" className="size-3.5" />
              ) : (
                <TrendingUp aria-hidden="true" className="size-3.5" />
              )}
              {`${growth < 0 ? '' : '+'}${percent(growth)} vs período anterior`}
            </span>
          )}
          {approved.pct !== null && (
            <span className={`${PILL} bg-secondary-fixed/40 text-secondary`}>
              <BadgeCheck aria-hidden="true" className="size-3.5" />
              {`${percent(approved.pct)} aprobado DNIT`}
            </span>
          )}
        </div>
      </Card>
      <Card
        label="En Cola Sincronizada"
        icon={<RefreshCw aria-hidden="true" className="size-[22px] text-tertiary" />}
      >
        <div className="mt-1 flex items-center gap-2">
          <span className={KPI_VALUE}>{integer(pending.count)}</span>
          <span className="font-body-sm text-body-sm text-outline">comprobantes</span>
        </div>
        <div className="mt-space-md flex flex-col gap-0.5 pt-space-xs font-label-sm text-label-sm text-on-surface-variant">
          {pending.count === 0 && <span>Sin pendientes</span>}
          {pending.overdue > 0 && (
            <span className="font-semibold text-error">{`${integer(pending.overdue)} vencidos (72 h)`}</span>
          )}
          {pending.dueSoon > 0 && <span>{`${integer(pending.dueSoon)} por vencer`}</span>}
        </div>
      </Card>
      <Card
        label="Rechazados"
        icon={<TriangleAlert aria-hidden="true" className="size-[22px] text-error" />}
      >
        <span className={`mt-1 ${KPI_VALUE}`}>{integer(s.rejected.count)}</span>
        <span className={`mt-space-md ${NOTE}`}>
          {s.rejected.topCodes.length === 0
            ? 'Sin rechazos'
            : `Motivos: ${s.rejected.topCodes.map(({ code, count }) => `${code} (${integer(count)})`).join(' · ')}`}
        </span>
      </Card>
    </section>
  );
}
