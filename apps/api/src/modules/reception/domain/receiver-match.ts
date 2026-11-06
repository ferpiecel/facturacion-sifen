export type ReceiverMatch = 'match' | 'mismatch' | 'unknown';

/** Tenant fiscal identity (`tenant_fiscal_profiles.ruc_base` + `ruc_dv`). */
export interface TenantFiscalRuc {
  readonly rucBase: string;
  readonly dv: number;
}

export interface SplitRuc {
  /** Digits without leading zeros. */
  readonly base: string;
  /** Check digit, or null when the input carried none. */
  readonly dv: number | null;
}

const LOOSE_RUC = /^(\d+)(?:-(\d))?$/;

/** Tolerant RUC reader: ignores spaces and dots, accepts `<base>` or `<base>-<dv>`. */
export function splitRuc(raw: string | null | undefined): SplitRuc | null {
  if (raw === null || raw === undefined) return null;
  const match = LOOSE_RUC.exec(raw.replace(/[\s.]/g, ''));
  if (!match) return null;
  const base = match[1].replace(/^0+(?=\d)/, '');
  return { base, dv: match.at(2) === undefined ? null : Number(match[2]) };
}

/**
 * Compares the receiver RUC of a document with the tenant's. The base decides; the check digit
 * is also compared when the receiver carries one. `unknown` when the receiver has no usable RUC.
 */
export function matchReceiver(
  receiverRuc: string | null | undefined,
  tenant: TenantFiscalRuc,
): ReceiverMatch {
  const receiver = splitRuc(receiverRuc);
  if (receiver === null) return 'unknown';
  const own = splitRuc(tenant.rucBase);
  if (own === null || receiver.base !== own.base) return 'mismatch';
  return receiver.dv === null || receiver.dv === tenant.dv ? 'match' : 'mismatch';
}
