import { validateXml, type ValidationResult } from '@sifen/sifen-xsd';

const SIFEN_NS = 'http://ekuatia.set.gov.py/sifen/xsd';

/**
 * Checks a signed event group against `siRecepEvento`. It is stored bare (the namespace comes from the
 * `rEnviEventoDe` around it), so the namespace is put back unless the group already carries one.
 */
export function validateEventXml(signedEventXml: string): ValidationResult {
  const bare = /^<gGroupGesEve\b(?![^>]*\sxmlns\s*=)/.test(signedEventXml);
  const xml = bare
    ? signedEventXml.replace(/^<gGroupGesEve\b/, `<gGroupGesEve xmlns="${SIFEN_NS}"`)
    : signedEventXml;
  return validateXml(xml, 'siRecepEvento');
}
