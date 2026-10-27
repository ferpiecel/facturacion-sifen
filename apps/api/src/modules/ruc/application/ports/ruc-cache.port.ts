import type { SifenContribuyente } from '@sifen/sifen-gateway';

export type RucEnvironment = 'test' | 'production';

/** A definite `siConsRUC` answer: the taxpayer when found, `null` when SIFEN says the RUC does not exist. */
export interface RucAnswer {
  readonly found: boolean;
  readonly contribuyente: SifenContribuyente | null;
}

export interface CachedRuc extends RucAnswer {
  readonly fetchedAt: Date;
}

/** Shared cache of RUC answers (HU-E6-09). Freshness is the caller's decision, from `fetchedAt`. */
export interface RucCache {
  get(environment: RucEnvironment, ruc: string): Promise<CachedRuc | null>;
  put(environment: RucEnvironment, ruc: string, answer: RucAnswer, now: Date): Promise<void>;
}
