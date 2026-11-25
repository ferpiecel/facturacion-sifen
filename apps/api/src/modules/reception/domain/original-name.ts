export const MAX_ORIGINAL_NAME_LENGTH = 255;

/** C0/C1 controls (NUL included), DEL, zero-width and bidi formatting, line and paragraph separators. */
const UNSAFE_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/**
 * The client-supplied file name is display data stored and echoed later: keep only its last path
 * segment, drop characters that can spoof or break it, and bound its length. Null when empty.
 */
export function sanitizeOriginalName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const last = name.split(/[\\/]/).at(-1) ?? '';
  const cleaned = last.replace(UNSAFE_CHARACTERS, '').trim().slice(0, MAX_ORIGINAL_NAME_LENGTH);
  return cleaned === '' ? null : cleaned;
}
