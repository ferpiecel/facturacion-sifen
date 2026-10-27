import { parseRuc } from '../../fiscal-config/domain/ruc.js';
import { validateInvoiceDraft } from './invoice-draft.js';
import type { ValidationConfig, ValidationError } from './invoice-draft.js';
import { validatePlace, type Place } from './place.js';

/** E501: motive of the remission (the closed MT table; 99 is "Otro"). */
export const REMISSION_MOTIVES = {
  1: 'Traslado por ventas',
  2: 'Traslado por consignación',
  3: 'Exportación',
  4: 'Traslado por compra',
  5: 'Importación',
  6: 'Traslado por devolución',
  7: 'Traslado entre locales de la empresa',
  8: 'Traslado de bienes por transformación',
  9: 'Traslado de bienes por reparación',
  10: 'Traslado por emisor móvil',
  11: 'Exhibición o demostración',
  12: 'Participación en ferias',
  13: 'Traslado de encomienda',
  14: 'Decomiso',
  99: 'Otro',
} as const;
/** E503: who answers for the remission. */
export const REMISSION_RESPONSIBLES = {
  1: 'Emisor de la factura',
  2: 'Poseedor de la factura y bienes',
  3: 'Empresa transportista',
  4: 'Despachante de Aduanas',
  5: 'Agente de transporte o intermediario',
} as const;
/** E901 and E903: transport type and modality. */
export const TRANSPORT_TYPES = { 1: 'Propio', 2: 'Tercero' } as const;
export const TRANSPORT_MODALITIES = {
  1: 'Terrestre',
  2: 'Fluvial',
  3: 'Aéreo',
  4: 'Multimodal',
} as const;
/** E905: who pays the freight. */
export const FREIGHT_RESPONSIBLES = {
  1: 'Emisor de la Factura Electrónica',
  2: 'Receptor de la Factura Electrónica',
  3: 'Tercero',
  4: 'Agente intermediario del transporte (cuando intervenga)',
  5: 'Transporte propio',
} as const;

/** The NRE motive that moves goods between the issuer's own premises (E501 = 7). */
export const OWN_PREMISES_MOTIVE = 7;

/** Motives whose receiver may be a non-taxpayer or a foreigner: export and import (D201 = 2). */
export const FOREIGN_RECEIVER_MOTIVES: readonly number[] = [3, 5];

export interface RemissionReceiver extends Place {
  /** `<base>-<dv>` (D206); absent for a non-taxpayer receiver, who then carries a document. */
  ruc?: string | undefined;
  /** iTipIDRec (D208): 1 to 4, for a receiver without RUC (motives 3 and 5 only). */
  idType?: number | undefined;
  /** dNumIDRec (D210). */
  idNumber?: string | undefined;
  /** cPaisRec (D213): ISO 3166 alpha-3, defaults to PRY. */
  countryCode?: string | undefined;
  /** dNomRec (D211): 4 to 255 characters. */
  name: string;
}

export interface RemissionVehicle {
  /** dTiVehTras (E968): 4 to 10 characters. */
  type: string;
  /** dMarVeh (E969): 1 to 10 characters. */
  brand: string;
  /** dTipIdenVeh (E970): 1 vehicle identification number, 2 plate. */
  idType: number;
  /** dNroIDVeh (E971): 1 to 20 characters. */
  idNumber: string;
}

export interface RemissionCarrier {
  /** iNatTrans (E980): true for a contribuyente (RUC), false otherwise (document). */
  contributor: boolean;
  /** dNomTrans (E981): 4 to 60 characters. */
  name: string;
  ruc?: string | undefined;
  /** iTipIDTrans (E985): 1 to 4, for a carrier that is not a contribuyente. */
  idType?: number | undefined;
  idNumber?: string | undefined;
  /** dDomFisc (E992). */
  address: string;
  driver: { name: string; idNumber: string; address: string };
}

export interface RemissionTransport {
  type: number;
  modality: number;
  freightResponsible: number;
  /** dIniTras and dFinTras (E922, E923): `AAAA-MM-DD`. */
  startDate: string;
  endDate: string;
  /** gCamSal (E921-E930) and gCamEnt (E941-E950). */
  departure: Place;
  delivery: Place;
  vehicle: RemissionVehicle;
  carrier: RemissionCarrier;
}

export interface RemissionDraft {
  motive: number;
  responsible: number;
  /** dKmR (E505): estimated kilometres, 1 to 99999. */
  km: number;
  /** dFecEm (E506): date of the invoice the goods travel with, optional. */
  invoiceDate?: string | undefined;
  receiver: RemissionReceiver;
  transport: RemissionTransport;
  /** The items carry a quantity only: an NRE has no price, tax or total (1851, E715 read strictly). */
  items: { quantity: number }[];
}

const has = (table: object, key: number): boolean => Object.hasOwn(table, key);

/** True for a real calendar day written `AAAA-MM-DD`. */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isValidRuc(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    parseRuc(raw);
    return true;
  } catch {
    return false;
  }
}

/** The invoice rules an NRE shares: it has quantities only. */
const SHARED_RULES: ReadonlySet<string> = new Set([
  'items-required',
  'quantity-positive',
  'quantity-precision',
]);

/**
 * Pure pre-SIFEN validation of an NRE (HU-E7-04). `issuerRuc` (`<base>-<dv>`) is known only inside
 * the transaction and enables the motive 7 rule (2606). Collects every violation.
 */
export function validateRemissionDraft(
  draft: RemissionDraft,
  config: ValidationConfig,
  issuerRuc?: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const add = (field: string, rule: string, message: string, sifenCode?: string) => {
    errors.push({ field, rule, message, ...(sifenCode === undefined ? {} : { sifenCode }) });
  };
  const { transport } = draft;

  if (!has(REMISSION_MOTIVES, draft.motive)) {
    add('motive', 'remission-motive', 'The motive must be 1 to 14 or 99 (E501)');
  }
  if (!has(REMISSION_RESPONSIBLES, draft.responsible)) {
    add('responsible', 'remission-responsible', 'The responsible must be 1 to 5 (E503)');
  }
  if (!Number.isInteger(draft.km) || draft.km < 1 || draft.km > 99_999) {
    add('km', 'remission-km', 'The kilometres must be an integer from 1 to 99999 (dKmR)');
  }
  if (draft.invoiceDate !== undefined && !isCalendarDay(draft.invoiceDate)) {
    add('invoiceDate', 'remission-invoice-date', 'The invoice date must be AAAA-MM-DD (dFecEm)');
  }
  if (
    draft.motive === OWN_PREMISES_MOTIVE &&
    issuerRuc !== undefined &&
    draft.receiver.ruc !== issuerRuc
  ) {
    add(
      'receiver.ruc',
      'remission-motive-7-receiver',
      'A transfer between the issuer premises (motive 7) must be addressed to the issuer RUC (E501)',
      '2606',
    );
  }

  const { receiver } = draft;
  if (receiver.ruc === undefined) {
    if (
      !FOREIGN_RECEIVER_MOTIVES.includes(draft.motive) ||
      receiver.idType === undefined ||
      ![1, 2, 3, 4].includes(receiver.idType) ||
      !receiver.idNumber
    ) {
      add(
        'receiver.idNumber',
        'remission-receiver-document',
        'A receiver without RUC is allowed only for export or import (motives 3 and 5) and needs a document type (1 to 4) and number (D208, D210)',
      );
    }
  } else if (!isValidRuc(receiver.ruc)) {
    add('receiver.ruc', 'remission-receiver-ruc', 'The receiver RUC is not valid (D206)');
  }

  if (!has(TRANSPORT_TYPES, transport.type)) {
    add('transport.type', 'remission-transport-type', 'The transport type must be 1 or 2 (E901)');
  }
  if (!has(TRANSPORT_MODALITIES, transport.modality)) {
    add(
      'transport.modality',
      'remission-transport-modality',
      'The transport modality must be 1 to 4 (E903)',
    );
  }
  if (!has(FREIGHT_RESPONSIBLES, transport.freightResponsible)) {
    add(
      'transport.freightResponsible',
      'remission-transport-freight-responsible',
      'The freight responsible must be 1 to 5 (E905)',
    );
  }
  if (
    !isCalendarDay(transport.startDate) ||
    !isCalendarDay(transport.endDate) ||
    transport.endDate < transport.startDate
  ) {
    add(
      'transport.startDate',
      'remission-transport-dates',
      'The start and end dates must be real days AAAA-MM-DD and the end not before the start (E922, E923)',
    );
  }
  if (transport.vehicle.idType !== 1 && transport.vehicle.idType !== 2) {
    add(
      'transport.vehicle.idType',
      'remission-vehicle-id-type',
      'The vehicle id type must be 1 or 2 (E970)',
    );
  }

  const { carrier } = transport;
  if (carrier.contributor) {
    if (!isValidRuc(carrier.ruc)) {
      add(
        'transport.carrier.ruc',
        'remission-carrier-ruc',
        'A contributor carrier needs a valid RUC (E983)',
      );
    }
  } else if (
    carrier.idType === undefined ||
    ![1, 2, 3, 4].includes(carrier.idType) ||
    !carrier.idNumber
  ) {
    add(
      'transport.carrier.idNumber',
      'remission-carrier-document',
      'A carrier that is not a contributor needs a document type (1 to 4) and number (E985)',
    );
  }

  errors.push(
    ...validatePlace('receiver', draft.receiver, config),
    ...validatePlace('transport.departure', transport.departure, config),
    ...validatePlace('transport.delivery', transport.delivery, config),
  );

  const shape = {
    receiver: {
      kind: 'named' as const,
      isPublicEntity: false,
    },
    operationType: 'B2B' as const,
    items: draft.items.map(({ quantity }) => ({ quantity, unitPrice: 0, vatRate: 0 as const })),
    roundingPyg: 0,
    location: {},
  };
  errors.push(...validateInvoiceDraft(shape, config).filter((e) => SHARED_RULES.has(e.rule)));
  return errors;
}
