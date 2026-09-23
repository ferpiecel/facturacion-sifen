import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The official signed SIFEN example is read-only reference material; it is
 * NOT valid against the current vendored XSD graph (placeholder RUCs, a
 * missing `dBasExe`, and a non-base64 certificate). See design.md
 * "Verified Facts" for the full explanation.
 */
const OFFICIAL_EXAMPLE_PATH = fileURLToPath(
  new URL('../../../../docs/referencia/ejemplos/ejemplo-de-firmado-v150.xml', import.meta.url),
);

/** Placeholder value shaped like `xs:base64Binary`, not a real certificate. */
const DUMMY_BASE64_CERT = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';

/** Reads the untouched official example, unmodified. */
export async function readOfficialExample(): Promise<string> {
  return readFile(OFFICIAL_EXAMPLE_PATH, 'utf8');
}

/**
 * Applies the minimal patch set that makes the official example pass
 * validation: real-looking RUCs, an explicit `dBasExe` in each `gCamIVA`
 * (schema order: after `dLiqIVAItem`), and a base64-shaped dummy certificate.
 */
export function patchExample(xml: string): string {
  return xml
    .replace('<dRucEm>00000001</dRucEm>', '<dRucEm>80000001</dRucEm>')
    .replace('<dRucRec>00000002</dRucRec>', '<dRucRec>80000002</dRucRec>')
    .replace(
      'DATOS DEL CERTIFICADO INSERTADO POR EL PROCESO DE FIRMA (SE RESTRINGE LA INFORMACIÓN EN ESTE EJEMPLO)',
      DUMMY_BASE64_CERT,
    )
    .replaceAll(
      /(<\/dLiqIVAItem>)(\s*)(<\/gCamIVA>)/g,
      (_match, close: string, whitespace: string, gCamIVAClose: string) =>
        `${close}${whitespace}<dBasExe>0</dBasExe>${whitespace}${gCamIVAClose}`,
    );
}

/** Reads the official example and applies {@link patchExample}. */
export async function readPatchedExample(): Promise<string> {
  return patchExample(await readOfficialExample());
}
