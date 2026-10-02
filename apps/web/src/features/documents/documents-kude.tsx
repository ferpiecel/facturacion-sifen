import { QrCode } from 'lucide-react';

import { MoneyPYG } from '../../design-system/components/money-pyg';
import { formatPYG } from '../../design-system/lib/format-pyg';
import { formatIssuedAt, iva10 } from './format';
import { SAMPLE_ISSUER as ISSUER, type DocumentKind, type DocumentRow } from './sample-documents';

const TITLES: Record<DocumentKind, string> = {
  FE: 'KuDE de Factura Electrónica',
  NCE: 'KuDE de Nota de Crédito Electrónica',
  NDE: 'KuDE de Nota de Débito Electrónica',
  AFE: 'KuDE de Autofactura Electrónica',
};

const CELL = 'font-code-sm text-code-sm';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-outline">{label}</span>
      <span className="font-semibold text-on-surface">{value}</span>
    </div>
  );
}

/** Printed-sheet preview of the KuDE (the real PDF comes from HU-E10-01). */
export function DocumentsKude({ doc }: { doc: DocumentRow }) {
  const { receiver, total } = doc;
  const iva = iva10(total);
  const items = doc.detail?.items ?? [
    { quantity: 1, description: 'Servicios (detalle de ejemplo)', unitPrice: total, total },
  ];

  return (
    <div className="flex w-full flex-col gap-4 rounded-xl bg-surface-container-lowest p-5 text-on-surface shadow-md">
      <div className="flex items-start justify-between pb-3">
        <div className="flex flex-col">
          <span className="font-headline-md text-headline-md font-bold tracking-tight">
            {ISSUER.name}
          </span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">
            {ISSUER.activity}
          </span>
          <span className="mt-1 font-label-sm text-label-sm text-outline">{ISSUER.address}</span>
          <span className="font-label-sm text-label-sm text-outline">{ISSUER.contact}</span>
        </div>
        <div className="flex flex-col items-end text-right">
          <span className="font-label-md text-label-md font-bold text-primary uppercase">
            {TITLES[doc.kind]}
          </span>
          <span className="font-label-sm text-label-sm font-semibold">{`RUC: ${ISSUER.ruc}`}</span>
          <span className="font-label-sm text-label-sm text-outline">
            Timbrado N°: <strong>{doc.timbrado}</strong>
          </span>
          <span className="font-label-sm text-label-sm text-outline">{`Vigencia: ${ISSUER.timbradoValidity}`}</span>
          <span className="mt-1 font-code-md text-code-md font-bold">{`N° ${doc.number}`}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1 rounded-lg bg-surface-container-low p-2.5">
        <div className="flex items-center justify-between font-label-sm text-label-sm">
          <span className="font-semibold text-primary">CÓDIGO DE CONTROL (CDC) - 44 DÍGITOS</span>
          <span className="font-bold text-secondary">
            Aprobado con Firma Electrónica Cualificada
          </span>
        </div>
        <div className="rounded bg-surface-container-lowest p-1.5 font-code-sm text-code-sm tracking-widest break-all select-all">
          {doc.cdc}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-lg bg-surface-container-low p-3 text-label-sm">
        <Field label="Razón Social:" value={receiver.name} />
        <Field label="RUC / Documento:" value={receiver.id} />
        <Field label="Condición de Venta:" value={doc.detail?.saleCondition ?? 'Contado'} />
        <Field label="Fecha y Hora de Emisión:" value={formatIssuedAt(doc.issuedAt)} />
      </div>
      <table className="w-full text-left">
        <thead>
          <tr className="bg-surface-container font-label-sm text-label-sm font-semibold">
            <th scope="col" className="rounded-tl p-2">
              Cant.
            </th>
            <th scope="col" className="p-2">
              Descripción del Ítem / Servicio
            </th>
            <th scope="col" className="p-2 text-right">
              Precio Unit.
            </th>
            <th scope="col" className="rounded-tr p-2 text-right">
              Total (IVA 10%)
            </th>
          </tr>
        </thead>
        <tbody className="font-body-sm text-body-sm">
          {items.map((item, index) => (
            <tr
              key={item.description}
              className={index % 2 === 0 ? '' : 'bg-surface-container-low'}
            >
              <td className={`p-2 ${CELL}`}>{item.quantity}</td>
              <td className="p-2 font-medium">{item.description}</td>
              <td className={`p-2 text-right ${CELL}`}>
                <MoneyPYG amount={item.unitPrice} />
              </td>
              <td className={`p-2 text-right font-semibold ${CELL}`}>
                <MoneyPYG amount={item.total} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-cols-3 gap-2 rounded bg-surface-container-low p-2.5 text-center font-label-sm text-label-sm">
        <Field label="Gravadas 5%:" value="₲ 0" />
        <Field label="Gravadas 10%:" value={formatPYG(total - iva)} />
        <Field label="Total Liquidación IVA (10%):" value={formatPYG(iva)} />
      </div>
      <div className="flex items-center justify-between rounded-lg bg-surface-container p-3">
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="flex size-16 items-center justify-center rounded-md bg-surface-container-lowest p-1 shadow-sm"
          >
            <QrCode className="size-12 text-on-surface" />
          </div>
          <div className="flex flex-col">
            <span className="font-label-sm text-label-sm text-outline">
              TOTAL A PAGAR (GUARANÍES):
            </span>
            <MoneyPYG
              amount={total}
              className="font-headline-lg text-headline-lg font-bold tracking-tight"
            />
            {doc.detail && (
              <span className="font-label-sm text-label-sm text-on-surface-variant italic">
                {`Son: ${doc.detail.amountInWords}`}
              </span>
            )}
          </div>
        </div>
        <span className="inline-block rounded-full bg-secondary-fixed px-2.5 py-1 font-code-sm text-code-sm font-bold text-on-secondary-fixed">
          SIFEN VALIDADO
        </span>
      </div>
    </div>
  );
}
