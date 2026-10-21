const PLAIN_ADDRESS = /^[^\s@<>",;:\\()[\]]+@[^\s@<>",;:\\()[\]]+\.[^\s@<>",;:\\()[\]]+$/;

/**
 * Exactly one bare address (`user@host.tld`): no display name, no angle brackets, no lists
 * (`,` or `;`), no quoting and no whitespace or line breaks. Anything else could address more
 * than one mailbox or inject headers once handed to a mail library.
 */
export function isPlainEmailAddress(value: string): boolean {
  return value.length <= 254 && PLAIN_ADDRESS.test(value);
}
