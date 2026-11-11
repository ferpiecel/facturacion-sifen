/** Default cap for one uploaded document; real SIFEN XMLs are 4-12 KB, the cap only stops abuse. */
export const DEFAULT_RECEPTION_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** Hard ceiling for the setting (the legacy system accepted 15 MiB for PDFs and photos). */
export const RECEPTION_MAX_UPLOAD_BYTES_CEILING = 15 * 1024 * 1024;

export interface ReceptionUploadConfig {
  readonly maxBytes: number;
}

/** Reads `RECEPTION_MAX_UPLOAD_BYTES`; an invalid value fails fast instead of falling back. */
export function loadReceptionUploadConfig(
  env: Readonly<Record<string, string | undefined>>,
): ReceptionUploadConfig {
  const raw = env.RECEPTION_MAX_UPLOAD_BYTES?.trim();
  if (raw === undefined || raw === '') return { maxBytes: DEFAULT_RECEPTION_MAX_UPLOAD_BYTES };
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > RECEPTION_MAX_UPLOAD_BYTES_CEILING) {
    throw new Error(
      `RECEPTION_MAX_UPLOAD_BYTES must be an integer between 1 and ${String(RECEPTION_MAX_UPLOAD_BYTES_CEILING)}.`,
    );
  }
  return { maxBytes: value };
}
