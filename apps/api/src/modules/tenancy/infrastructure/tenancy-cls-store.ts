import type { ClsStore } from 'nestjs-cls';

/** Single CLS key used to carry the resolved tenant id through a request/job. */
export const TENANT_ID_CLS_KEY = 'tenantId' as const;

/** Typed CLS store for this module: extends the base store with `tenantId`. */
export interface TenancyClsStore extends ClsStore {
  [TENANT_ID_CLS_KEY]: string;
}
