/** Which SIFEN environment a tenant's documents are emitted for (backlog HU-E2-04, ADR-0012). */
export type TenantEnvironment = 'test' | 'production';

/**
 * Mandatory literal for the issuer's legal name (dNomEmi) and the first
 * item's description (dDesProSer) on every document a "test" tenant emits
 * (Guía de Pruebas 2026 §2, plan-desarrollo-v1.1.md §15.2). By ADR-0012's
 * precedence order the Guía prevails over the MT v150/xml_DE example, which
 * uses a different wording — resolved on paper as D2, still pending
 * confirmation with the Prevalidador SIFEN, hence configurable rather than
 * inlined at every call site (see {@link resolveIssuerDocumentContent} and
 * {@link validateIssuerDocumentContent}'s `testLiteral` parameter).
 */
export const DEFAULT_TEST_DOCUMENT_LITERAL =
  'DOCUMENTO ELECTRÓNICO SIN VALOR COMERCIAL NI FISCAL - GENERADO EN AMBIENTE DE PRUEBA';

/** Thrown when a document's issuer content does not match its tenant environment's literal rule. */
export class InvalidDocumentEnvironmentError extends Error {
  constructor(reason: string) {
    super(`Invalid document environment content: ${reason}`);
    this.name = 'InvalidDocumentEnvironmentError';
  }
}

/** The issuer's real legal name (dNomEmi) and the real first item description (dDesProSer). */
export interface RealIssuerDocumentContent {
  legalName: string;
  firstItemDescription: string;
}

/** What actually goes on the wire for dNomEmi and the first item's dDesProSer. */
export interface IssuerDocumentContent {
  legalName: string;
  firstItemDescription: string;
}

/**
 * Resolves what to emit as the issuer's legal name and the first item's
 * description (HU-E2-04): the mandatory test literal in `"test"`, the real
 * values in `"production"`. `testLiteral` defaults to
 * {@link DEFAULT_TEST_DOCUMENT_LITERAL} but is overridable per call so the
 * platform can reconfigure it (D2) without touching this function's callers.
 */
export function resolveIssuerDocumentContent(
  environment: TenantEnvironment,
  real: RealIssuerDocumentContent,
  testLiteral: string = DEFAULT_TEST_DOCUMENT_LITERAL,
): IssuerDocumentContent {
  if (environment === 'test') {
    return { legalName: testLiteral, firstItemDescription: testLiteral };
  }
  return { legalName: real.legalName, firstItemDescription: real.firstItemDescription };
}

/**
 * Validates a document about to be emitted against its tenant's environment
 * (HU-E2-04): a `"production"` document must never carry the test literal on
 * either field, and a `"test"` document must carry it on both — so neither a
 * misconfigured prod tenant nor a test tenant emitting real data slips
 * through. `testLiteral` mirrors {@link resolveIssuerDocumentContent}'s
 * override for the same D2 configurability.
 */
export function validateIssuerDocumentContent(
  environment: TenantEnvironment,
  content: IssuerDocumentContent,
  testLiteral: string = DEFAULT_TEST_DOCUMENT_LITERAL,
): void {
  if (environment === 'production') {
    if (content.legalName.includes(testLiteral) || content.firstItemDescription.includes(testLiteral)) {
      throw new InvalidDocumentEnvironmentError(
        'a "production" document must not contain the mandatory test literal (dNomEmi/dDesProSer)',
      );
    }
    return;
  }

  if (content.legalName !== testLiteral || content.firstItemDescription !== testLiteral) {
    throw new InvalidDocumentEnvironmentError(
      'a "test" document must carry the mandatory test literal on both the issuer legal name (dNomEmi) and the first item description (dDesProSer)',
    );
  }
}
