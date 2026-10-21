/** Default pause after SIFEN blocks a RUC: inside the 10 to 60 minutes of the Guía 2024 (HU-E6-05). */
export const DEFAULT_RUC_BLOCK_MS = 30 * 60_000;

/**
 * Whether the text of a 0301 says the RUC is blocked. The Guía 2024 words the cause as "Estar bloqueado
 * por envío duplicado" and blocks the "RUC Emisor"; SIFEN's exact dMsgRes is not confirmed (to be checked
 * against sifen-test). So the text must say blocked (not "desbloqueado", not "bloque" alone) and name the
 * RUC, the issuer or a duplicate send. A wrong match only pauses a tenant for a while; documents stay queued.
 */
export function isRucBlockMessage(message: string): boolean {
  const text = message.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const says = /\bbloquead[oa]\b|\bbloqueo\b/.test(text);
  return says && /\bruc\b|\bemisor\b|\bcontribuyente\b|\bduplicado\b/.test(text);
}
