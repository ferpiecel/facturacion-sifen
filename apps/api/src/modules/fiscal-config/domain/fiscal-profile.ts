import type { Ruc } from './ruc.js';

/** iTipCont (Manual Técnico v150, §D2, field D103): 1 = Persona Física, 2 = Persona Jurídica. */
export type TaxpayerType = 'persona_fisica' | 'persona_juridica';

export const TAXPAYER_TYPE_CODES: Record<TaxpayerType, 1 | 2> = {
  persona_fisica: 1,
  persona_juridica: 2,
};

/** Thrown when a fiscal profile or one of its economic activities fails validation. */
export class InvalidFiscalProfileError extends Error {
  constructor(reason: string) {
    super(`Invalid fiscal profile: ${reason}`);
    this.name = 'InvalidFiscalProfileError';
  }
}

/**
 * cTipReg (MT §D2, field D104): "Según Tabla 1 – Tipo de Régimen". That code
 * list is not present in the DNIT docs shipped with this repo
 * (docs/referencia/dnit), so this slice validates format only — 1 to 2
 * digits, matching the field's declared length — and leaves the closed code
 * list for a later slice once the table is sourced. The field is itself
 * optional in the MT (occurrence 0-1).
 */
const REGIME_CODE_PATTERN = /^\d{1,2}$/;

/**
 * cActEco (MT §D2.1, field D131): "Según Tabla 3 – Actividades Económicas".
 * Same situation as the regime code: the closed code list is not in the
 * shipped docs, so this slice validates format only (1 to 8 alphanumeric
 * characters, the field's declared length).
 */
const ECONOMIC_ACTIVITY_CODE_PATTERN = /^[A-Za-z0-9]{1,8}$/;

/** Maximum economic activities per emitter: gActEco occurrence is 1-9 (MT §D2.1). */
const MAX_ECONOMIC_ACTIVITIES = 9;

export interface EconomicActivity {
  /** cActEco */
  readonly code: string;
  /** dDesActEco (1-300 chars) */
  readonly description: string;
}

export interface FiscalProfile {
  readonly ruc: Ruc;
  /** dNomEmi (4-255 chars) */
  readonly legalName: string;
  /** dNomFanEmi (4-255 chars), optional */
  readonly tradeName: string | null;
  readonly taxpayerType: TaxpayerType;
  /** cTipReg, optional */
  readonly regimeCode: string | null;
  /** gActEco, 1-9 entries */
  readonly economicActivities: readonly EconomicActivity[];
}

export interface CreateFiscalProfileInput {
  ruc: Ruc;
  legalName: string;
  tradeName?: string | null;
  taxpayerType: TaxpayerType;
  regimeCode?: string | null;
  economicActivities: EconomicActivity[];
}

/**
 * Builds a {@link FiscalProfile}, validating every field this slice owns
 * (HU-E2-01): legal/trade name length, the optional regime code format, and
 * 1-9 economic activities with a valid code/description.
 */
export function createFiscalProfile(input: CreateFiscalProfileInput): FiscalProfile {
  const legalName = validateName(input.legalName, 'legalName (dNomEmi)');

  const trimmedTradeName = input.tradeName?.trim();
  const tradeName =
    trimmedTradeName === undefined || trimmedTradeName === ''
      ? null
      : validateName(trimmedTradeName, 'tradeName (dNomFanEmi)');

  const trimmedRegimeCode = input.regimeCode?.trim();
  const regimeCode =
    trimmedRegimeCode === undefined || trimmedRegimeCode === '' ? null : trimmedRegimeCode;
  if (regimeCode !== null && !REGIME_CODE_PATTERN.test(regimeCode)) {
    throw new InvalidFiscalProfileError(
      `regimeCode "${regimeCode}" must be 1 to 2 digits (cTipReg)`,
    );
  }

  if (
    input.economicActivities.length < 1 ||
    input.economicActivities.length > MAX_ECONOMIC_ACTIVITIES
  ) {
    throw new InvalidFiscalProfileError(
      `economicActivities must have 1 to ${String(MAX_ECONOMIC_ACTIVITIES)} entries (gActEco), ` +
        `got ${String(input.economicActivities.length)}`,
    );
  }
  const economicActivities = input.economicActivities.map(validateEconomicActivity);

  return {
    ruc: input.ruc,
    legalName,
    tradeName,
    taxpayerType: input.taxpayerType,
    regimeCode,
    economicActivities,
  };
}

function validateName(raw: string, field: string): string {
  const value = raw.trim();
  if (value.length < 4 || value.length > 255) {
    throw new InvalidFiscalProfileError(`${field} must be 4 to 255 characters`);
  }
  return value;
}

function validateEconomicActivity(activity: EconomicActivity): EconomicActivity {
  const code = activity.code.trim();
  if (!ECONOMIC_ACTIVITY_CODE_PATTERN.test(code)) {
    throw new InvalidFiscalProfileError(
      `economicActivities code "${activity.code}" must be 1 to 8 alphanumeric characters (cActEco)`,
    );
  }

  const description = activity.description.trim();
  if (description.length < 1 || description.length > 300) {
    throw new InvalidFiscalProfileError(
      'economicActivities description must be 1 to 300 characters (dDesActEco)',
    );
  }

  return { code, description };
}
