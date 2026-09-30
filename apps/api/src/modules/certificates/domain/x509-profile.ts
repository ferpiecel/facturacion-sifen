import { derChildren, DerError, readDerElement, type DerNode } from './der.js';

/**
 * Certificate fields node:crypto does not expose in structured form, read
 * straight from the DER so no string rendering can be spoofed.
 */
export interface X509Profile {
  /** Subject `serialNumber` (2.5.4.5) attribute values. */
  readonly subjectSerialNumbers: readonly string[];
  /** `serialNumber` values inside SubjectAltName directoryName entries only. */
  readonly sanSerialNumbers: readonly string[];
  /** basicConstraints pathLenConstraint; `null` when unconstrained. */
  readonly pathLength: number | null;
  /** keyUsage digitalSignature bit; `false` when the extension is absent. */
  readonly digitalSignature: boolean;
}

const TAG_VERSION = 0xa0;
const TAG_EXTENSIONS = 0xa3;
const TAG_DIRECTORY_NAME = 0xa4;
const TAG_INTEGER = 0x02;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
/** PrintableString and IA5String: ASCII subsets. */
const ASCII_STRING_TAGS = new Set([0x13, 0x16]);

const OID_SERIAL_NUMBER = '550405'; // 2.5.4.5
const OID_KEY_USAGE = '551d0f'; // 2.5.29.15
const OID_SUBJECT_ALT_NAME = '551d11'; // 2.5.29.17
const OID_BASIC_CONSTRAINTS = '551d13'; // 2.5.29.19

const DIGITAL_SIGNATURE_BIT = 0x80;
const MAX_PATH_LENGTH_OCTETS = 4;

/** @throws DerError when the certificate is not the DER X.509 structure expected. */
export function readX509Profile(der: Buffer): X509Profile {
  const fields = derChildren(required(derChildren(readDerElement(der)).at(0)));
  const subject = required(fields.at(fields.at(0)?.tag === TAG_VERSION ? 5 : 4));
  const extensions = readExtensions(fields.find((field) => field.tag === TAG_EXTENSIONS));

  const san = extensions.get(OID_SUBJECT_ALT_NAME);
  const basicConstraints = extensions.get(OID_BASIC_CONSTRAINTS);
  const keyUsage = extensions.get(OID_KEY_USAGE);
  return {
    subjectSerialNumbers: serialNumbersOf(subject),
    sanSerialNumbers:
      san === undefined
        ? []
        : derChildren(readDerElement(san))
            .filter((name) => name.tag === TAG_DIRECTORY_NAME)
            .flatMap((name) => serialNumbersOf(readDerElement(name.content))),
    pathLength: basicConstraints === undefined ? null : pathLengthOf(basicConstraints),
    digitalSignature:
      keyUsage !== undefined &&
      ((readDerElement(keyUsage).content.at(1) ?? 0) & DIGITAL_SIGNATURE_BIT) !== 0,
  };
}

function required(node: DerNode | undefined): DerNode {
  if (node === undefined) throw new DerError();
  return node;
}

/** Extension OID (hex) → extnValue content (the DER inside the OCTET STRING). */
function readExtensions(wrapper: DerNode | undefined): Map<string, Buffer> {
  const extensions = new Map<string, Buffer>();
  if (wrapper === undefined) return extensions;
  for (const extension of derChildren(required(derChildren(wrapper).at(0)))) {
    const parts = derChildren(extension);
    const oid = required(parts.at(0));
    if (oid.tag !== TAG_OID) throw new DerError();
    extensions.set(oid.content.toString('hex'), required(parts.at(-1)).content);
  }
  return extensions;
}

/** `serialNumber` attribute values of a Name (SEQUENCE OF SET OF AttributeTypeAndValue). */
function serialNumbersOf(name: DerNode): string[] {
  return derChildren(name)
    .flatMap(derChildren)
    .flatMap((attribute) => {
      const parts = derChildren(attribute);
      const type = parts.at(0);
      const value = parts.at(1);
      if (type?.tag !== TAG_OID || type.content.toString('hex') !== OID_SERIAL_NUMBER) return [];
      if (value?.tag === TAG_UTF8_STRING) return [value.content.toString('utf8')];
      if (value !== undefined && ASCII_STRING_TAGS.has(value.tag)) {
        return [value.content.toString('latin1')];
      }
      return [];
    });
}

function pathLengthOf(basicConstraints: Buffer): number | null {
  const pathLength = derChildren(readDerElement(basicConstraints)).find(
    (node) => node.tag === TAG_INTEGER,
  );
  if (pathLength === undefined) return null;
  const { content } = pathLength;
  if (content.length === 0 || content.length > MAX_PATH_LENGTH_OCTETS) throw new DerError();
  const value = content.readIntBE(0, content.length);
  if (value < 0) throw new DerError();
  return value;
}
