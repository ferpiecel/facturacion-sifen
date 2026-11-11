import { SIFEN_CODES, type SifenGateway } from '@sifen/sifen-gateway';
import type { RucAnswer, RucCache, RucEnvironment } from './ports/ruc-cache.port.js';

const RUC_BASE = /^\d{5,8}$/;

/** SIFEN refused the query for the caller's certificate (0501). Depends on the caller, so it is never cached. */
export class RucLookupDeniedError extends Error {
  constructor() {
    super('SIFEN did not allow this certificate to query RUCs');
    this.name = 'RucLookupDeniedError';
  }
}

/** SIFEN answered with a code this lookup does not know. Only the code is kept, never the body. */
export class RucLookupFailedError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Unexpected siConsRUC code ${code}`);
    this.name = 'RucLookupFailedError';
    this.code = code;
  }
}

export interface RucLookupResult extends RucAnswer {
  readonly cached: boolean;
}

export interface LookupRucDeps {
  /** The SIFEN gateway of the calling tenant (its own certificate and environment). */
  readonly gatewayFor: (tenantId: string) => SifenGateway;
  /** The environment the tenant works in: it picks the endpoint and keys the cache. */
  readonly environmentOf: (tenantId: string) => Promise<RucEnvironment>;
  readonly cache: RucCache;
  /** 0 disables the cache. */
  readonly ttlSeconds: number;
  readonly now: () => Date;
  readonly nextDId: () => bigint;
}

/**
 * Queries a RUC (5 to 8 digits, no check digit) for a tenant through the cache of the tenant's environment. Found (0502) and not found (0500) are
 * cached for `ttlSeconds`; 0501, unknown codes and gateway failures are not.
 * @throws RangeError for a malformed RUC
 */
export function createLookupRuc(deps: LookupRucDeps) {
  const { gatewayFor, environmentOf, cache, ttlSeconds, now, nextDId } = deps;
  return async (tenantId: string, ruc: string): Promise<RucLookupResult> => {
    if (!RUC_BASE.test(ruc))
      throw new RangeError('ruc must have 5 to 8 digits, without the check digit');
    const environment = await environmentOf(tenantId);
    if (ttlSeconds > 0) {
      const hit = await cache.get(environment, ruc);
      if (hit !== null && now().getTime() - hit.fetchedAt.getTime() < ttlSeconds * 1000) {
        return { found: hit.found, contribuyente: hit.contribuyente, cached: true };
      }
    }
    const response = await gatewayFor(tenantId).consultarRUC({ dId: nextDId(), ruc });
    if (response.dCodRes === SIFEN_CODES.RUC_SIN_PERMISO) throw new RucLookupDeniedError();
    const found =
      response.dCodRes === SIFEN_CODES.RUC_ENCONTRADO && response.contribuyente !== null;
    if (!found && response.dCodRes !== SIFEN_CODES.RUC_INEXISTENTE) {
      throw new RucLookupFailedError(response.dCodRes);
    }
    const answer: RucAnswer = { found, contribuyente: found ? response.contribuyente : null };
    if (ttlSeconds > 0) await cache.put(environment, ruc, answer, now());
    return { ...answer, cached: false };
  };
}
