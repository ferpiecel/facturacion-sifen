/** Malformed or unsupported DER; carries no bytes of the input. */
export class DerError extends Error {
  constructor() {
    super('malformed or unsupported DER');
    this.name = 'DerError';
  }
}

/** One DER TLV: its identifier octet and a view of its content octets. */
export interface DerNode {
  readonly tag: number;
  readonly content: Buffer;
}

const CONSTRUCTED = 0x20;
const HIGH_TAG_NUMBER = 0x1f;
const LONG_LENGTH = 0x80;
const MAX_LENGTH_OCTETS = 4;

/**
 * Splits `input` into consecutive DER elements, bounds-checking every
 * length. Only what X.509 needs is supported: low tag numbers and definite
 * lengths; anything else throws {@link DerError}.
 */
export function readDerElements(input: Buffer): DerNode[] {
  const nodes: DerNode[] = [];
  let offset = 0;
  while (offset < input.length) {
    if (offset + 2 > input.length) throw new DerError();
    const tag = input[offset];
    if ((tag & HIGH_TAG_NUMBER) === HIGH_TAG_NUMBER) throw new DerError();
    let length = input[offset + 1];
    let start = offset + 2;
    if ((length & LONG_LENGTH) !== 0) {
      const octets = length & ~LONG_LENGTH;
      if (octets === 0 || octets > MAX_LENGTH_OCTETS || start + octets > input.length) {
        throw new DerError();
      }
      length = input.readUIntBE(start, octets);
      start += octets;
    }
    const end = start + length;
    if (end > input.length) throw new DerError();
    nodes.push({ tag, content: input.subarray(start, end) });
    offset = end;
  }
  return nodes;
}

/** The elements inside a constructed node. */
export function derChildren(node: DerNode): DerNode[] {
  if ((node.tag & CONSTRUCTED) === 0) throw new DerError();
  return readDerElements(node.content);
}

/** The single element `input` must consist of. */
export function readDerElement(input: Buffer): DerNode {
  const nodes = readDerElements(input);
  const [node] = nodes;
  if (nodes.length !== 1) throw new DerError();
  return node;
}
