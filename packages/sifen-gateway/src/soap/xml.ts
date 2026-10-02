/** A parsed XML element. Names are local names: namespace prefixes are dropped. */
export interface XmlNode {
  readonly name: string;
  readonly children: XmlNode[];
  /** Concatenated character data directly inside the element. */
  text: string;
  /** The element's exact source text, tags included. */
  raw: string;
}

export class XmlParseError extends Error {
  readonly name = 'XmlParseError';
}

const MAX_DEPTH = 64;
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);
const TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>!?]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|<!|[^<]+|</gy;
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(\w+));/g;

function decode(text: string): string {
  return text.replace(ENTITY, (_match, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) {
      const value = ENTITIES.get(name);
      if (value === undefined) throw new XmlParseError(`Unknown entity &${name};`);
      return value;
    }
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff)
      throw new XmlParseError('Bad character reference');
    return String.fromCodePoint(code);
  });
}

const localName = (qualified: string): string => qualified.slice(qualified.indexOf(':') + 1);

/**
 * Minimal, strict XML reader for SIFEN SOAP responses. It rejects DOCTYPE/entity declarations
 * (no XXE or entity expansion), resolves only the five predefined and numeric entities, caps nesting
 * depth, and requires exactly one root element.
 * @throws XmlParseError on anything malformed
 */
export function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new XmlParseError('DTDs are not allowed');
  const stack: { node: XmlNode; start: number; qname: string }[] = [];
  let root: XmlNode | undefined;
  TOKEN.lastIndex = 0;
  let position = 0;

  while (position < xml.length) {
    TOKEN.lastIndex = position;
    const match = TOKEN.exec(xml);
    if (match === null) throw new XmlParseError(`Unparseable markup at offset ${String(position)}`);
    const groups: readonly (string | undefined)[] = match;
    const [token = '', cdata, closing, qname, , selfClosing] = groups;
    const start = position;
    position = TOKEN.lastIndex;
    const top = stack.at(-1);

    if (token === '<!' || token === '<')
      throw new XmlParseError(`Unsupported markup at offset ${String(start)}`);
    if (cdata !== undefined) {
      if (top === undefined) throw new XmlParseError('Character data outside the root element');
      top.node.text += cdata;
    } else if (qname === undefined) {
      if (token.startsWith('<!--') || token.startsWith('<?')) continue;
      if (top !== undefined) top.node.text += decode(token);
      else if (token.trim() !== '')
        throw new XmlParseError('Character data outside the root element');
    } else if (closing === '/') {
      if (top === undefined || top.qname !== qname)
        throw new XmlParseError(`Unexpected closing tag </${qname}>`);
      top.node.raw = xml.slice(top.start, position);
      stack.pop();
    } else {
      if (top === undefined && root !== undefined)
        throw new XmlParseError('More than one root element');
      if (stack.length >= MAX_DEPTH) throw new XmlParseError('Document is nested too deeply');
      const node: XmlNode = { name: localName(qname), children: [], text: '', raw: '' };
      if (top === undefined) root = node;
      else top.node.children.push(node);
      if (selfClosing === '/') node.raw = xml.slice(start, position);
      else stack.push({ node, start, qname });
    }
  }

  if (stack.length > 0) throw new XmlParseError('Unclosed element');
  if (root === undefined) throw new XmlParseError('No root element');
  return root;
}

export const children = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter((child) => child.name === name);

export const firstChild = (node: XmlNode, name: string): XmlNode | undefined =>
  node.children.find((child) => child.name === name);

/** Trimmed text of the first child with this local name, or `undefined` when absent. */
export const childText = (node: XmlNode, name: string): string | undefined =>
  firstChild(node, name)?.text.trim();
