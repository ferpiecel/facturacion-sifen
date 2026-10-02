import { X509Certificate } from 'node:crypto';

/** The PSC trusted-roots configuration is missing or unusable; the operator CLI fails closed. */
export class TrustedRootsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedRootsError';
  }
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * Parses a PEM bundle of PSC root certificates (the MIC-enabled roots, never hardcoded: the
 * validator trusts exactly this list). A corrupt block fails the whole bundle so a typo cannot
 * silently drop a root.
 */
export function parseTrustedRoots(pem: string): X509Certificate[] {
  const blocks = pem.match(PEM_BLOCK) ?? [];
  if (blocks.length === 0) throw new TrustedRootsError('trusted roots bundle has no certificate');
  return blocks.map((block) => {
    try {
      return new X509Certificate(block);
    } catch {
      throw new TrustedRootsError('trusted roots bundle has an unreadable certificate');
    }
  });
}

/** Loads the PEM bundle named by `PSC_TRUSTED_ROOTS_PATH`; fails closed without it. */
export function loadTrustedRoots(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): X509Certificate[] {
  const path = env.PSC_TRUSTED_ROOTS_PATH;
  if (!path)
    throw new TrustedRootsError('PSC_TRUSTED_ROOTS_PATH is required (PSC root bundle, PEM)');
  let pem: string;
  try {
    pem = readFile(path);
  } catch {
    // No cause: the path is operator-supplied, the OS error adds nothing safe to print.
    throw new TrustedRootsError('PSC_TRUSTED_ROOTS_PATH could not be read');
  }
  return parseTrustedRoots(pem);
}
