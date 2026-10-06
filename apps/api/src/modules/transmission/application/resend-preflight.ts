import { SIFEN_CODES, type SifenGateway } from '@sifen/sifen-gateway';
import type { ReadyDocument, ResendCheck, ResendVerdict } from './assemble-lotes.js';
import type { DocumentResolution } from './poll-lote-result.js';
import { deIdOf } from './recover-lote-by-cdc.js';

export interface ResendPreflightStore {
  /**
   * Settles a queued, resent document as approved because SIFEN holds it (queued -> submitted ->
   * approved, with its events). False, nothing written, when it is no longer in that state.
   */
  approveFound(documentId: string, resolution: DocumentResolution): Promise<boolean>;
}

export interface ResendPreflightDeps {
  readonly gateway: Pick<SifenGateway, 'consultarDE'>;
  readonly store: ResendPreflightStore;
  readonly nextRequestId: () => Promise<bigint>;
}

/**
 * The last look before a resend (HU-E6-04, Guía 2024: resend after 0420 with the same CDC): SIFEN is
 * asked once more right before the document joins a lote. 0420 clears the send; 0422 means SIFEN
 * approved it after the recovery's last answer, so it is approved here and never sent; anything else
 * (an error, an odd code, a DE that is not this one) is "wait": not knowing is never permission to send.
 */
export class ResendPreflight implements ResendCheck {
  constructor(private readonly deps: ResendPreflightDeps) {}

  async verify(document: ReadyDocument): Promise<ResendVerdict> {
    let answer;
    try {
      answer = await this.deps.gateway.consultarDE({
        dId: await this.deps.nextRequestId(),
        cdc: document.cdc as Parameters<SifenGateway['consultarDE']>[0]['cdc'],
      });
    } catch {
      return 'wait';
    }
    if (answer.dCodRes === SIFEN_CODES.CDC_INEXISTENTE) return 'send';
    if (
      answer.dCodRes === SIFEN_CODES.CDC_ENCONTRADO &&
      answer.xmlDE !== null &&
      deIdOf(answer.xmlDE) === document.cdc
    ) {
      const stored = await this.deps.store.approveFound(document.documentId, {
        cdc: document.cdc,
        status: 'approved',
        messages: [{ code: answer.dCodRes, message: answer.dMsgRes.slice(0, 500) }],
      });
      return stored ? 'approved' : 'wait';
    }
    return 'wait';
  }
}
