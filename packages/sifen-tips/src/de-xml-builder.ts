import xmlgen from 'facturacionelectronicapy-xmlgen';
import type { DeXmlBuilder, FacturaPocInput } from '@sifen/sifen-gateway';
import { resolveCjsDefault } from './cjs-interop.ts';

interface XmlgenApi {
  generateXMLDE(params: Readonly<Record<string, unknown>>, data: Readonly<Record<string, unknown>>): Promise<string>;
}

const xmlgenApi = resolveCjsDefault(xmlgen) as XmlgenApi;

/** Thin adapter over `facturacionelectronicapy-xmlgen` (ADR-0015). */
export class TipsDeXmlBuilder implements DeXmlBuilder {
  async buildParaSifen(input: FacturaPocInput): Promise<string> {
    return xmlgenApi.generateXMLDE(input.params, input.data);
  }
}
