import { validateXml, type ValidationResult } from '@sifen/sifen-xsd';

const SIFEN_NS = 'http://ekuatia.set.gov.py/sifen/xsd';

/**
 * Checks a signed event group against `siRecepEvento`. The group is stored bare: it takes its default
 * namespace from the `rEnviEventoDe` that wraps it when sent, so the namespace is put back to validate it.
 */
export function validateEventXml(signedEventXml: string): ValidationResult {
  return validateXml(
    signedEventXml.replace(/^<gGroupGesEve\b/, `<gGroupGesEve xmlns="${SIFEN_NS}"`),
    'siRecepEvento',
  );
}
