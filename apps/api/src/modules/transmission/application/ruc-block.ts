/** Default pause after SIFEN blocks a RUC: inside the 10 to 60 minutes of the Guía 2024 (HU-E6-05). */
export const DEFAULT_RUC_BLOCK_MS = 30 * 60_000;

/**
 * Whether the text of a 0301 says the RUC is blocked. SIFEN's exact wording is not confirmed (to be
 * checked against sifen-test), so this matches the stem "bloque", ignoring case and accents, and
 * rejects "desbloque...". A wrong match only pauses a tenant for a while; the documents stay queued.
 */
export function isRucBlockMessage(message: string): boolean {
  const text = message.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return /(?<!des)bloque/.test(text);
}
