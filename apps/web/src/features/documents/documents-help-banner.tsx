import { ExternalLink, Lightbulb } from 'lucide-react';

/** Contextual help footer of the Stitch screen; windows per HU-E8-02 (FE 48 h, others 168 h). */
export function DocumentsHelpBanner() {
  return (
    <aside className="flex flex-col items-center justify-between gap-4 rounded-xl bg-surface-container-high p-4 sm:flex-row">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary">
          <Lightbulb aria-hidden="true" className="size-5" />
        </div>
        <div className="flex flex-col">
          <span className="font-headline-md text-headline-md font-bold text-on-surface">
            ¿Dudas sobre cómo anular o rectificar un comprobante electrónico?
          </span>
          <span className="font-body-sm text-body-sm text-on-surface-variant">
            Aprende sobre los plazos de cancelación ante la DNIT (hasta 48 hs desde la aprobación
            para facturas y 168 hs para el resto) y la emisión reglamentaria de Notas de Crédito.
          </span>
        </div>
      </div>
      <a
        href="#"
        className="inline-flex items-center gap-1 font-label-md text-label-md font-bold whitespace-nowrap text-primary hover:underline"
      >
        <span>Ver tutorial de 2 minutos</span>
        <ExternalLink aria-hidden="true" className="size-4" />
      </a>
    </aside>
  );
}
