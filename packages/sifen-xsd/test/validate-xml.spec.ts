import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractSchemaLocationNames } from '../scripts/refresh-xsd.ts';
import { vendorDir } from '../src/schemas.ts';
import { describe, expect, it } from 'vitest';
import { validateXml } from '../src/validate-xml.ts';
import { readOfficialExample, readPatchedExample } from './fixtures/patch-example.ts';

describe('validateXml', () => {
  it('rejects the untouched official example for its three documented reasons', async () => {
    const xml = await readOfficialExample();

    const result = validateXml(xml, 'siRecepDE');

    expect(result.valid).toBe(false);
    const messages = result.errors.map((error) => error.message).join('\n');
    expect(messages).toMatch(/00000001|00000002|pattern/i);
    expect(messages).toMatch(/dBasExe/);
    expect(messages).toMatch(/X509Certificate|base64/i);
  });

  it('accepts the patched official example (RUCs, dBasExe, dummy cert)', async () => {
    const xml = await readPatchedExample();

    const result = validateXml(xml, 'siRecepDE');

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects a document missing a required element and names it', async () => {
    const xml = (await readPatchedExample()).replace('<dVerFor>150</dVerFor>\n    ', '');

    const result = validateXml(xml, 'siRecepDE');

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.message.includes('dVerFor'))).toBe(true);
  });

  it('rejects a document with a value outside its enumeration', async () => {
    const xml = (await readPatchedExample()).replace(
      '<iTipEmi>1</iTipEmi>',
      '<iTipEmi>9</iTipEmi>',
    );

    const result = validateXml(xml, 'siRecepDE');

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.message.includes('iTipEmi'))).toBe(true);
  });

  it('never throws on malformed XML and reports it as invalid', () => {
    const result = validateXml('<rDE><unclosed>', 'siRecepDE');

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatchObject({ line: 1, column: 16 });
    expect(result.errors[0]?.message).toMatch(/Premature end of data/);
  });

  it('normalizes a non-libxml2 failure (e.g. an unknown schema) into a single generic error', async () => {
    const xml = await readPatchedExample();

    const result = validateXml(xml, 'unknownSchema' as never);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    expect(typeof error.message).toBe('string');
    expect(error).toMatchObject({ line: null, column: null, path: null });
  });

  it('resolves every schemaLocation reference from the vendored files, never the network', () => {
    const vendored = readdirSync(vendorDir).filter((name) => name.endsWith('.xsd'));
    const references = vendored.flatMap((name) =>
      extractSchemaLocationNames(readFileSync(join(vendorDir, name), 'utf8')),
    );

    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((name) => !vendored.includes(name))).toEqual([]);
  });
});
