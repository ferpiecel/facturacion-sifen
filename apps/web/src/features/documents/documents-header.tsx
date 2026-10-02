import { ChevronRight, CirclePlus, RefreshCw, ShieldCheck, Table } from 'lucide-react';
import Link from 'next/link';

const SECONDARY_ACTION =
  'inline-flex items-center gap-2 rounded-lg px-3.5 py-2 font-body-sm text-body-sm font-medium text-on-surface transition-all hover:bg-surface-container-high';

/** Breadcrumb, title and primary actions of the Stitch "Comprobantes y KuDE" screen. */
export function DocumentsHeader() {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-col gap-1.5">
        <nav
          aria-label="Ruta de navegación"
          className="flex flex-wrap items-center gap-2 font-label-md text-label-md text-on-surface-variant"
        >
          <Link href="/" className="transition-colors hover:text-primary">
            Inicio
          </Link>
          <ChevronRight aria-hidden="true" className="size-3.5 text-outline" />
          <span>Documentos Emitidos</span>
          <ChevronRight aria-hidden="true" className="size-3.5 text-outline" />
          <span aria-current="page" className="font-semibold text-on-surface">
            Comprobantes y KuDE
          </span>
          <span className="ml-2 flex items-center gap-1.5 rounded-full bg-test-environment px-2.5 py-0.5 font-code-sm text-code-sm font-semibold text-on-test-environment">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-test-environment-accent" />
            Ambiente de pruebas
          </span>
          <span className="flex items-center gap-1 rounded-md bg-surface-container-high px-2 py-0.5 font-code-sm text-code-sm text-on-surface">
            <ShieldCheck aria-hidden="true" className="size-3.5 text-primary" />
            DNIT v150 Sincronizado
          </span>
        </nav>
        <div className="flex flex-col">
          <h1 className="font-headline-xl text-headline-xl tracking-tight text-on-surface">
            Explorador y Validación de Comprobantes
          </h1>
          <p className="mt-0.5 font-body-md text-body-md text-on-surface-variant">
            Consulta, audita y valida tus facturas electrónicas, notas de crédito y KuDE oficiales
            ante la DNIT en tiempo real.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          className={`${SECONDARY_ACTION} bg-surface-container-lowest shadow-sm`}
        >
          <Table aria-hidden="true" className="size-[18px] text-primary" />
          Exportar Fiscal (CSV/XLS)
        </button>
        <button type="button" className={`${SECONDARY_ACTION} bg-surface-container`}>
          <RefreshCw aria-hidden="true" className="size-[18px] text-secondary" />
          Verificar Lote DNIT
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg bg-primary-container px-4 py-2 font-body-sm text-body-sm font-semibold text-on-primary shadow-sm transition-all hover:bg-primary"
        >
          <CirclePlus aria-hidden="true" className="size-[18px]" />
          Nueva Factura
        </button>
      </div>
    </header>
  );
}
