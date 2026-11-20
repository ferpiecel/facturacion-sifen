'use client';

import { useCallback, type ReactNode } from 'react';

import { StatusBadge } from '../../design-system/components/status-badge';
import { useRemote } from '../documents/use-remote';
import { ArtifactViewer } from './artifact-viewer';
import {
  receptionClient,
  type ReceivedDocumentDetail,
  type ReceptionClient,
} from './reception-client';

const MESSAGE = 'p-6 text-center font-body-sm text-body-sm text-on-surface-variant';
const CARD = 'flex flex-col gap-3 rounded-xl bg-surface-container-lowest p-4 shadow-sm';
const HEADING = 'font-headline-sm text-headline-sm font-bold text-on-surface';

const TOTAL_LABELS: readonly [keyof ReceivedDocumentDetail['totals'], string][] = [
  ['exempt', 'Exento'],
  ['zero_rated', 'Tasa 0 %'],
  ['taxable_5', 'Gravado 5 %'],
  ['taxable_10', 'Gravado 10 %'],
  ['vat_5', 'IVA 5 %'],
  ['vat_10', 'IVA 10 %'],
  ['total_vat', 'Total IVA'],
  ['discount', 'Descuento'],
  ['total_amount', 'Total'],
  ['total_pyg', 'Total en PYG'],
];

const show = (value: string | number | null) =>
  value === null || value === '' ? '-' : String(value);

function Fields({
  title,
  rows,
}: {
  title: string;
  rows: readonly [string, string | number | null][];
}) {
  return (
    <section aria-label={title} className={CARD}>
      <h3 className={HEADING}>{title}</h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="font-label-sm text-label-sm text-on-surface-variant">{label}</dt>
            <dd className="font-body-md text-body-md text-on-surface">{show(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Flags({ doc }: { doc: ReceivedDocumentDetail }) {
  if (doc.is_own_receiver && !doc.needs_review && !doc.extraction_error_code) return null;
  return (
    <section aria-label="Alertas" className={`${CARD} gap-2`}>
      {!doc.is_own_receiver && (
        <span className="w-fit rounded-full bg-error-container px-2 py-0.5 font-label-sm text-label-sm font-semibold text-on-error-container">
          Otro receptor
        </span>
      )}
      {doc.needs_review && (
        <div>
          <p className="font-label-md text-label-md font-semibold text-on-surface">
            Motivos de revisión
          </p>
          <ul className="list-disc pl-5 font-body-sm text-body-sm text-on-surface-variant">
            {doc.needs_review_reasons.map((reason, index) => (
              // Reasons can repeat, so the index is part of the key.
              <li key={`${String(index)}:${reason}`}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {doc.extraction_error_code && (
        <p className="font-body-sm text-body-sm text-on-surface">
          {'Error de extracción: '}
          <code>{doc.extraction_error_code}</code>
        </p>
      )}
    </section>
  );
}

function Items({ items }: { items: ReceivedDocumentDetail['items'] }) {
  return (
    <section aria-label="Ítems del documento" className={`${CARD} overflow-x-auto`}>
      <h3 className={HEADING}>Ítems</h3>
      {items.length === 0 ? (
        <p className="font-body-sm text-body-sm text-on-surface-variant">Sin ítems extraídos.</p>
      ) : (
        <table aria-label="Ítems" className="w-full text-left font-body-sm text-body-sm">
          <thead>
            <tr>
              {[
                '#',
                'Descripción',
                'Código',
                'Cantidad',
                'Unidad',
                'Precio',
                'Subtotal',
                'IVA %',
                'IVA',
              ].map((head) => (
                <th key={head} scope="col" className="px-2 py-1 font-label-md text-label-md">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.position}>
                {[
                  item.position,
                  item.description,
                  item.product_code,
                  item.quantity,
                  item.unit_of_measure,
                  item.unit_price,
                  item.subtotal,
                  item.vat_rate,
                  item.vat_amount,
                ].map((cell, index) => (
                  <td key={index} className="px-2 py-1">
                    {show(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Body({
  doc,
  client,
}: {
  doc: ReceivedDocumentDetail;
  client: ReceptionClient;
}): ReactNode {
  const { issuer, receiver, totals } = doc;
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-headline-md text-headline-md font-bold text-on-surface">
          {doc.document_number ?? 'Documento sin número'}
        </h2>
        <StatusBadge status={doc.status} />
      </header>
      <Flags doc={doc} />
      <Fields
        title="Datos del documento"
        rows={[
          ['CDC', doc.cdc],
          ['Fecha de emisión', doc.issued_on],
          ['Moneda', doc.currency],
          ['Tipo de cambio', doc.exchange_rate],
          ['Timbrado', doc.timbrado],
          ['Serie', doc.series],
          ['Establecimiento', doc.establishment_code],
          ['Punto de expedición', doc.expedition_point_code],
          ['Secuencia', doc.document_sequence],
          ['Origen', doc.source],
        ]}
      />
      <Fields
        title="Emisor"
        rows={[
          ['RUC', issuer.ruc],
          ['Razón social', issuer.legal_name],
          ['Nombre comercial', issuer.trade_name],
          ['Dirección', issuer.address],
          ['Actividad económica', issuer.economic_activity],
        ]}
      />
      <Fields
        title="Receptor"
        rows={[
          ['RUC', receiver.ruc],
          ['Razón social', receiver.legal_name],
        ]}
      />
      <Items items={doc.items} />
      <Fields title="Totales" rows={TOTAL_LABELS.map(([key, label]) => [label, totals[key]])} />
      <section aria-label="Artefacto" className={CARD}>
        <h3 className={HEADING}>Artefacto</h3>
        <ArtifactViewer artifact={doc.artifact} href={client.artifactUrl(doc.id)} />
      </section>
    </div>
  );
}

/** Read-only detail of a received document: status, extracted fields, flags, items and the artifact. */
export function ReceivedDetail({
  id,
  client = receptionClient,
}: {
  id: string;
  client?: ReceptionClient;
}) {
  const load = useCallback(() => client.detail(id), [client, id]);
  const { state, retry } = useRemote(load);

  if (!state)
    return (
      <p role="status" className={MESSAGE}>
        Cargando documento recibido…
      </p>
    );
  if (state.kind === 'ok') return <Body doc={state.document} client={client} />;
  if (state.kind === 'not_found')
    return (
      <p role="alert" className={MESSAGE}>
        El documento recibido no existe o no pertenece a la empresa activa.
      </p>
    );
  return (
    <div role="alert" className={`${MESSAGE} flex flex-col items-center gap-2`}>
      <span>No pudimos cargar el documento recibido.</span>
      <button
        type="button"
        onClick={retry}
        className="rounded bg-surface-container px-3 py-1.5 font-label-md text-label-md font-semibold text-primary hover:bg-surface-container-high"
      >
        Reintentar
      </button>
    </div>
  );
}
