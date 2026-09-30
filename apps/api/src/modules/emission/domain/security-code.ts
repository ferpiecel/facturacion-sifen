import { randomBytes as nodeRandomBytes } from 'node:crypto';

/** dNumDoc is not an integer in 1..9999999. */
export class InvalidDocumentNumberError extends Error {
  constructor(value: string | number) {
    super(`invalid dNumDoc: ${String(value)} (expected an integer 1..9999999)`);
    this.name = 'InvalidDocumentNumberError';
  }
}

/** Source of cryptographically secure random bytes (injectable for tests). */
export type RandomBytes = (size: number) => Buffer;

const CODE_SPACE = 1_000_000_000; // 000000000..999999999
const UINT32_SPACE = 2 ** 32;
/** Largest multiple of CODE_SPACE that fits in a uint32; draws at or above it are rejected. */
const ACCEPT_BELOW = UINT32_SPACE - (UINT32_SPACE % CODE_SPACE);

function parseDocumentNumber(value: string | number): number {
  const text = String(value);
  const parsed = Number(text);
  if (!/^\d{1,7}$/.test(text) || parsed < 1) throw new InvalidDocumentNumberError(value);
  return parsed;
}

/**
 * Generates `dCodSeg` (MT v150): 9 zero-padded digits from a CSPRNG, part of
 * the 44-digit CDC, and always different from `dNumDoc` (compared zero-padded).
 * Uses rejection sampling so every code is equally likely (no modulo bias).
 *
 * @throws InvalidDocumentNumberError when `documentNumber` is not 1..9999999.
 */
export function generateSecurityCode(
  documentNumber: string | number,
  randomBytes: RandomBytes = nodeRandomBytes,
): string {
  const forbidden = parseDocumentNumber(documentNumber);
  for (;;) {
    const draw = randomBytes(4).readUInt32BE(0);
    if (draw >= ACCEPT_BELOW) continue;
    const code = draw % CODE_SPACE;
    if (code !== forbidden) return String(code).padStart(9, '0');
  }
}
