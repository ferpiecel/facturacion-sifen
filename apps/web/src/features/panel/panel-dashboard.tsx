import { ArrowRight, EllipsisVertical, ListFilter } from 'lucide-react';
import Link from 'next/link';

import { BRAND } from '../../design-system/brand';
import { CdcDisplay } from '../../design-system/components/cdc-display';
import { MoneyPYG } from '../../design-system/components/money-pyg';
import { StatusBadge } from '../../design-system/components/status-badge';
import { PanelKpis } from './panel-kpis';
import { SAMPLE_RECENT_DOCUMENTS, type DocumentType } from './sample-data';

const TYPE_CHIP: Record<DocumentType, string> = {
  FE: 'bg-primary-fixed text-primary',
  NC: 'bg-secondary-fixed text-on-secondary-fixed',
  AF: 'bg-surface-container text-on-surface',
};

function Hero() {
  return (
    <div className="relative overflow-hidden rounded-xl bg-gradient-to-r from-primary to-primary-container p-space-lg text-on-primary shadow-md">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-12 -bottom-16 size-80 rounded-full bg-white/10 blur-2xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 right-40 size-44 rounded-full bg-secondary-fixed/20 blur-xl"
      />
      <div className="relative z-10 flex max-w-2xl flex-col gap-space-xs">
        <div className="flex flex-wrap items-center gap-space-xs">
          <div className="inline-flex w-fit items-center gap-space-xs rounded-full bg-white/15 px-2.5 py-1 backdrop-blur-md">
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-secondary-fixed motion-safe:animate-ping"
            />
            <span className="font-code-sm text-code-sm font-semibold tracking-wider text-secondary-fixed uppercase">
              SIFEN Paraguay DNIT v150
            </span>
          </div>
          <span className="inline-flex w-fit rounded-full bg-white/15 px-2.5 py-1 font-label-sm text-label-sm text-white backdrop-blur-md">
            Datos de ejemplo
          </span>
        </div>
        <h1 className="font-headline-xl text-headline-xl tracking-tight text-white">{`¡Bienvenido a ${BRAND.name}!`}</h1>
        <p className="max-w-xl font-body-md text-body-md text-white">
          Tu asistente inteligente de facturación electrónica DNIT.
        </p>
      </div>
    </div>
  );
}

function RecentDocuments() {
  return (
    <section
      aria-labelledby="recent-documents-title"
      className="flex flex-col rounded-xl bg-surface-container-lowest p-space-lg shadow-sm"
    >
      <div className="flex flex-col gap-space-sm pb-space-md md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col">
          <div className="flex items-center gap-space-xs">
            <h2
              id="recent-documents-title"
              className="font-headline-md text-headline-md text-on-surface"
            >
              Comprobantes Electrónicos Recientes
            </h2>
            <span className="rounded-full bg-surface-container px-2 py-0.5 font-code-sm text-code-sm font-bold text-on-surface-variant">
              Últimos 5
            </span>
          </div>
          <span className="font-body-sm text-body-sm text-outline">
            Transmisión instantánea con Código de Control (CDC) de 44 dígitos
          </span>
        </div>
        <div className="flex items-center gap-space-xs">
          <Link
            href="/comprobantes"
            className="flex items-center gap-1 rounded-lg bg-surface-container-low px-space-md py-1.5 font-label-sm text-label-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high"
          >
            <ListFilter aria-hidden="true" className="size-4" />
            <span>Filtrar</span>
          </Link>
          <Link
            href="/comprobantes"
            className="flex items-center gap-1 rounded-lg bg-primary-container px-space-md py-1.5 font-label-sm text-label-sm font-semibold text-on-primary shadow-sm transition-all hover:bg-primary"
          >
            <span>Ver Todos</span>
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
      </div>
      <div
        role="region"
        aria-label="Tabla de comprobantes recientes"
        tabIndex={0}
        className="-mx-space-lg overflow-x-auto px-space-lg"
      >
        <table
          aria-labelledby="recent-documents-title"
          className="w-full border-collapse text-left"
        >
          <thead>
            <tr className="bg-surface-container-low font-label-sm text-label-sm tracking-wider text-outline uppercase">
              <th scope="col" className="rounded-l-lg px-4 py-3">
                Tipo &amp; Número
              </th>
              <th scope="col" className="px-4 py-3">
                Cliente / Receptor
              </th>
              <th scope="col" className="px-4 py-3">
                CDC (Identificador SIFEN)
              </th>
              <th scope="col" className="px-4 py-3 text-right">
                Monto Total
              </th>
              <th scope="col" className="px-4 py-3 text-center">
                Estado DNIT
              </th>
              <th scope="col" className="rounded-r-lg px-4 py-3 text-right">
                Acciones
              </th>
            </tr>
          </thead>
          <tbody className="font-body-sm text-body-sm">
            {SAMPLE_RECENT_DOCUMENTS.map((doc) => (
              <tr key={doc.cdc} className="transition-colors hover:bg-surface-container-low/60">
                <td className="px-4 py-3.5 font-semibold text-on-surface">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 font-code-sm text-code-sm font-bold ${TYPE_CHIP[doc.type]}`}
                    >
                      {doc.type}
                    </span>
                    <span>{doc.number}</span>
                  </div>
                </td>
                <td className="px-4 py-3.5">
                  <div className="flex flex-col">
                    <span className="font-semibold text-on-surface">{doc.receiver}</span>
                    <span className="font-code-sm text-code-sm text-outline">{doc.receiverId}</span>
                  </div>
                </td>
                <td className="px-4 py-3.5">
                  <CdcDisplay value={doc.cdc} variant="truncated" />
                </td>
                <td className="px-4 py-3.5 text-right">
                  <MoneyPYG
                    amount={doc.amount}
                    className="font-headline-md text-headline-md font-semibold text-on-surface"
                  />
                </td>
                <td className="px-4 py-3.5 text-center">
                  <StatusBadge status={doc.status} />
                </td>
                <td className="px-4 py-3.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      title="Descargar KuDE PDF"
                      className="rounded px-2 py-1 font-label-sm text-label-sm font-semibold text-primary transition-colors hover:bg-surface-container-high"
                    >
                      KuDE
                    </button>
                    <button
                      type="button"
                      title="Descargar XML Firmado"
                      className="rounded px-2 py-1 font-label-sm text-label-sm font-semibold text-outline transition-colors hover:text-on-surface"
                    >
                      XML
                    </button>
                    <button
                      type="button"
                      aria-label={`Más acciones para ${doc.number}`}
                      className="rounded p-1 text-outline transition-colors hover:text-primary"
                    >
                      <EllipsisVertical aria-hidden="true" className="size-[18px]" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Content of the Stitch "Panel de Control y Monitoreo SIFEN" screen (this slice's subset). */
export function PanelDashboard() {
  return (
    <div className="mx-auto flex w-full max-w-[1520px] flex-col gap-space-lg px-space-lg py-space-lg">
      <Hero />
      <PanelKpis />
      <RecentDocuments />
    </div>
  );
}
