import { BRAND } from '../../design-system/brand';
import { PanelKpis } from './panel-kpis';
import { RecentDocuments } from './recent-documents';

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
        </div>
        <h1 className="font-headline-xl text-headline-xl tracking-tight text-white">{`¡Bienvenido a ${BRAND.name}!`}</h1>
        <p className="max-w-xl font-body-md text-body-md text-white">
          Tu asistente inteligente de facturación electrónica DNIT.
        </p>
      </div>
    </div>
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
