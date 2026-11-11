import { isPlainEmailAddress } from './plain-email-address.js';

export type ReceiverEmail =
  | { readonly kind: 'address'; readonly address: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * The receiver's address (`dEmailRec`, D213) in the signed DE. An innominado receiver carries none
 * (`none`); anything that is not exactly one bare address (a list, a display name) is `invalid`.
 */
export function readReceiverEmail(signedXml: string): ReceiverEmail {
  const match = /<(?:[\w.-]+:)?dEmailRec(?:\s[^>]*)?>([^<]*)<\//.exec(signedXml);
  if (match === null) return { kind: 'none' };
  const address = match[1]
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name])
    .trim();
  if (address === '') return { kind: 'none' };
  return isPlainEmailAddress(address) ? { kind: 'address', address } : { kind: 'invalid' };
}
