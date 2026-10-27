import type { NominationEventReceiver } from '@sifen/sifen-gateway';
import type { DraftReceiver, InvoiceDraft } from './invoice-draft.js';

/**
 * HU-E8-05 (NT 015, H004i/2442): once SIFEN approves the nomination of an FE issued to an unnamed
 * receiver, an NCE or NDE associated to it names that receiver. The nomination is stored by the
 * platform (`issuer_events.nomination`), already validated; this only reads it back.
 */
export function readNominatedReceiver(value: unknown): NominationEventReceiver | null {
  const candidate = value as Partial<NominationEventReceiver> | null;
  const kind = candidate?.kind;
  if (kind !== 'taxpayer' && kind !== 'non-taxpayer') return null;
  return typeof candidate?.name === 'string' ? (candidate as NominationEventReceiver) : null;
}

/** The receiver, operation and location the note rules and the XML take from the nominated FE. */
export function nominatedFacts(
  nominated: NominationEventReceiver,
): Pick<InvoiceDraft, 'receiver' | 'operationType' | 'location'> {
  const { address, houseNumber, districtCode, cityCode, departmentCode } = nominated;
  const receiver: DraftReceiver = {
    kind: 'named',
    isPublicEntity: false,
    ...(address === undefined
      ? {}
      : {
          address: {
            street: address,
            ...(houseNumber === undefined ? {} : { houseNumber }),
            ...(districtCode === undefined ? {} : { districtCode }),
            ...(cityCode === undefined ? {} : { cityCode }),
          },
        }),
  };
  return {
    receiver,
    operationType: nominated.operationType,
    location: departmentCode === undefined ? {} : { departmentCode },
  };
}
