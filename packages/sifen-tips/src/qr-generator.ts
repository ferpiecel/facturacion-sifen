import qrgen from 'facturacionelectronicapy-qrgen';
import type { QrConfig, QrGenerator } from '@sifen/sifen-gateway';
import { resolveCjsDefault } from './cjs-interop.ts';

interface QrgenApi {
  generateQR(xmlSigned: string, idCSC: string, CSC: string, env: 'test' | 'prod'): Promise<string>;
}

const qrgenApi = resolveCjsDefault(qrgen) as QrgenApi;

/** Thin adapter over `facturacionelectronicapy-qrgen` (ADR-0015). */
export class TipsQrGenerator implements QrGenerator {
  async addQr(signedXml: string, config: QrConfig): Promise<string> {
    return qrgenApi.generateQR(signedXml, config.idCsc, config.csc, config.ambiente);
  }
}
