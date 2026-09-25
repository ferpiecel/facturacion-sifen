/** Thrown when an expedition point code fails format validation. */
export class InvalidExpeditionPointError extends Error {
  constructor(reason: string) {
    super(`Invalid expedition point: ${reason}`);
    this.name = 'InvalidExpeditionPointError';
  }
}

// dPunExp (MT §C006 / XSD tdPunExp): 3 digits. HU-E2-02's criteria further
// restrict it to 001-999 (a real code, not all zeros), matching dEst.
const EXPEDITION_POINT_CODE_PATTERN = /^(?!000$)\d{3}$/;

export interface ExpeditionPoint {
  /** dPunExp */
  readonly code: string;
}

export interface CreateExpeditionPointInput {
  code: string;
}

/** Builds an {@link ExpeditionPoint} (HU-E2-02), validating the 3-digit code. */
export function createExpeditionPoint(input: CreateExpeditionPointInput): ExpeditionPoint {
  const code = input.code.trim();
  if (!EXPEDITION_POINT_CODE_PATTERN.test(code)) {
    throw new InvalidExpeditionPointError(
      `code "${input.code}" must be 3 digits, 001-999 (dPunExp)`,
    );
  }
  return { code };
}
