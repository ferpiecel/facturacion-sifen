import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  XmlBufferInputProvider,
  XmlDocument,
  XmlLibError,
  XsdValidator,
  xmlRegisterInputProvider,
} from 'libxml2-wasm';
import { schemaRootFile, vendorDir, type SifenSchema } from './schemas.ts';

/** Official absolute base URL vendored schemas reference each other with. */
const BASE_URL = 'https://ekuatia.set.gov.py/sifen/xsd/';

/**
 * Registers every vendored `.xsd` file under both its bare filename and its
 * official absolute URL, so `xsd:include`/`xsd:import` resolution never
 * touches the network. `xmlRegisterInputProvider` is process-global; this
 * runs once at module load.
 */
function registerVendorInputProvider(): void {
  const buffers: Record<string, Buffer> = {};
  for (const name of readdirSync(vendorDir)) {
    if (!name.endsWith('.xsd')) continue;
    const bytes = readFileSync(join(vendorDir, name));
    buffers[name] = bytes;
    buffers[`${BASE_URL}${name}`] = bytes;
  }
  xmlRegisterInputProvider(new XmlBufferInputProvider(buffers));
}

registerVendorInputProvider();

const validatorCache = new Map<SifenSchema, XsdValidator>();

/** Compiles (once) and caches an `XsdValidator` for the given schema. */
function getValidator(schema: SifenSchema): XsdValidator {
  const cached = validatorCache.get(schema);
  if (cached) return cached;

  const rootFile = schemaRootFile(schema);
  const rootBytes = readFileSync(join(vendorDir, rootFile));
  const schemaDoc = XmlDocument.fromBuffer(rootBytes, { url: `${BASE_URL}${rootFile}` });
  let validator: XsdValidator;
  try {
    validator = XsdValidator.fromDoc(schemaDoc);
  } finally {
    schemaDoc.dispose();
  }
  validatorCache.set(schema, validator);
  return validator;
}

/** A single schema-validation failure, normalized across error sources. */
export interface XsdError {
  message: string;
  line: number | null;
  column: number | null;
  path: string | null;
}

export interface ValidationResult {
  valid: boolean;
  errors: XsdError[];
}

function toXsdErrors(error: unknown): XsdError[] {
  // Parse and validation errors both carry libxml2 details; line/col 0 means "unknown".
  if (error instanceof XmlLibError && error.details.length > 0) {
    return error.details.map((detail) => ({
      message: detail.message.trim(),
      line: detail.line || null,
      column: detail.col || null,
      path: detail.xpath ?? null,
    }));
  }
  return [
    {
      message: (error instanceof Error ? error.message : String(error)).trim(),
      line: null,
      column: null,
      path: null,
    },
  ];
}

/**
 * Validates `xml` against the vendored `schema`. Never throws: malformed XML
 * or a schema-validation failure both resolve to `valid: false` with one or
 * more normalized {@link XsdError} entries.
 */
export function validateXml(xml: string, schema: SifenSchema): ValidationResult {
  let doc: XmlDocument;
  try {
    doc = XmlDocument.fromString(xml);
  } catch (error) {
    return { valid: false, errors: toXsdErrors(error) };
  }

  try {
    getValidator(schema).validate(doc);
    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: toXsdErrors(error) };
  } finally {
    doc.dispose();
  }
}
