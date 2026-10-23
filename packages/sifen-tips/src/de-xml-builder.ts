import xmlgen from 'facturacionelectronicapy-xmlgen';
import type { DeXmlBuilder, FacturaPocInput } from '@sifen/sifen-gateway';
import { resolveCjsDefault } from './cjs-interop.ts';

interface XmlgenApi {
  generateXMLDE(
    params: Readonly<Record<string, unknown>>,
    data: Readonly<Record<string, unknown>>,
    config?: Readonly<Record<string, unknown>>,
  ): Promise<string>;
}

const xmlgenApi = resolveCjsDefault(xmlgen) as XmlgenApi;

const SILENCED = ['log', 'info', 'debug'] as const;
let silenceDepth = 0;
type ConsoleMethod = (...args: unknown[]) => void;
let saved: Partial<Record<(typeof SILENCED)[number], ConsoleMethod>> = {};

/**
 * xmlgen console.logs request data (the seller location of an AFE, personal data) to the process
 * stdout. Runs `fn` with those console methods muted and restores them after, also with concurrent
 * calls (the first mutes, the last restores) and when `fn` throws.
 */
async function withoutXmlgenConsole<T>(fn: () => Promise<T>): Promise<T> {
  if (silenceDepth++ === 0) {
    saved = {};
    for (const method of SILENCED) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- restored as is, never called detached
      saved[method] = console[method];
      console[method] = () => undefined;
    }
  }
  try {
    return await fn();
  } finally {
    if (--silenceDepth === 0) {
      for (const method of SILENCED) console[method] = saved[method] as never;
    }
  }
}

/** Thin adapter over `facturacionelectronicapy-xmlgen` (ADR-0015). */
export class TipsDeXmlBuilder implements DeXmlBuilder {
  async buildParaSifen(input: FacturaPocInput): Promise<string> {
    // Without options the call stays exactly as before, so documents keep their bytes.
    return withoutXmlgenConsole(() =>
      input.config
        ? xmlgenApi.generateXMLDE(input.params, input.data, input.config)
        : xmlgenApi.generateXMLDE(input.params, input.data),
    );
  }
}
