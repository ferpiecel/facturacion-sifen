import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_DOCUMENT_LITERAL,
  InvalidDocumentEnvironmentError,
  resolveIssuerDocumentContent,
  validateIssuerDocumentContent,
} from './document-environment.js';

const REAL_CONTENT = {
  legalName: 'Acme S.A.',
  firstItemDescription: 'Consultoría profesional',
};

describe('resolveIssuerDocumentContent', () => {
  it('returns the mandatory test literal for both fields in "test"', () => {
    const content = resolveIssuerDocumentContent('test', REAL_CONTENT);

    expect(content.legalName).toBe(DEFAULT_TEST_DOCUMENT_LITERAL);
    expect(content.firstItemDescription).toBe(DEFAULT_TEST_DOCUMENT_LITERAL);
  });

  it('returns the real issuer values in "production"', () => {
    const content = resolveIssuerDocumentContent('production', REAL_CONTENT);

    expect(content).toEqual(REAL_CONTENT);
  });

  it('uses a configured literal instead of the default when given one (D2)', () => {
    const configuredLiteral = 'DE generado en ambiente de prueba - sin valor comercial ni fiscal';

    const content = resolveIssuerDocumentContent('test', REAL_CONTENT, configuredLiteral);

    expect(content.legalName).toBe(configuredLiteral);
    expect(content.firstItemDescription).toBe(configuredLiteral);
  });
});

describe('validateIssuerDocumentContent', () => {
  it('accepts a test document that carries the literal on both fields', () => {
    expect(() =>
      validateIssuerDocumentContent('test', {
        legalName: DEFAULT_TEST_DOCUMENT_LITERAL,
        firstItemDescription: DEFAULT_TEST_DOCUMENT_LITERAL,
      }),
    ).not.toThrow();
  });

  it('rejects a test document missing the literal in the legal name', () => {
    expect(() =>
      validateIssuerDocumentContent('test', {
        legalName: REAL_CONTENT.legalName,
        firstItemDescription: DEFAULT_TEST_DOCUMENT_LITERAL,
      }),
    ).toThrow(InvalidDocumentEnvironmentError);
  });

  it('rejects a test document missing the literal in the first item description', () => {
    expect(() =>
      validateIssuerDocumentContent('test', {
        legalName: DEFAULT_TEST_DOCUMENT_LITERAL,
        firstItemDescription: REAL_CONTENT.firstItemDescription,
      }),
    ).toThrow(InvalidDocumentEnvironmentError);
  });

  it('accepts a production document that carries real values', () => {
    expect(() => validateIssuerDocumentContent('production', REAL_CONTENT)).not.toThrow();
  });

  it('rejects a production document whose legal name carries the test literal', () => {
    expect(() =>
      validateIssuerDocumentContent('production', {
        legalName: DEFAULT_TEST_DOCUMENT_LITERAL,
        firstItemDescription: REAL_CONTENT.firstItemDescription,
      }),
    ).toThrow(InvalidDocumentEnvironmentError);
  });

  it('rejects a production document whose first item description carries the test literal', () => {
    expect(() =>
      validateIssuerDocumentContent('production', {
        legalName: REAL_CONTENT.legalName,
        firstItemDescription: DEFAULT_TEST_DOCUMENT_LITERAL,
      }),
    ).toThrow(InvalidDocumentEnvironmentError);
  });

  it('validates against a configured literal instead of the default (D2)', () => {
    const configuredLiteral = 'DE generado en ambiente de prueba - sin valor comercial ni fiscal';

    expect(() =>
      validateIssuerDocumentContent(
        'production',
        { legalName: configuredLiteral, firstItemDescription: REAL_CONTENT.firstItemDescription },
        configuredLiteral,
      ),
    ).toThrow(InvalidDocumentEnvironmentError);

    expect(() =>
      validateIssuerDocumentContent(
        'test',
        { legalName: configuredLiteral, firstItemDescription: configuredLiteral },
        configuredLiteral,
      ),
    ).not.toThrow();
  });
});
