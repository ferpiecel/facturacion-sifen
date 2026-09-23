import { fileURLToPath } from 'node:url';

/** SIFEN XML document types this package can validate. */
export type SifenSchema = 'siRecepDE';

const SCHEMA_ROOT_FILES: Record<SifenSchema, string> = {
  siRecepDE: 'siRecepDE_v150.xsd',
};

/** Absolute path to the vendored schema directory, resolved relative to this module. */
export const vendorDir = fileURLToPath(new URL('../vendor/', import.meta.url));

/** Returns the vendored root XSD filename for a given schema. */
export function schemaRootFile(schema: SifenSchema): string {
  return SCHEMA_ROOT_FILES[schema];
}
