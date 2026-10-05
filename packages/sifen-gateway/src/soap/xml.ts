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
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(\w+));/g;
const NAME = /[A-Za-z_][\w.:-]*/y;
const BLANK = /\s/;

function decode(text: string): string {
  if (text.replace(ENTITY, '').includes('&'))
    throw new XmlParseError('Bare ampersand in character data');
  return text.replace(ENTITY, (_match, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) {
      const value = ENTITIES.get(name);
      if (value === undefined) throw new XmlParseError(`Unknown entity &${name};`);
      return value;
    }
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(dec);
    const surrogate = code >= 0xd800 && code <= 0xdfff;
    if (!Number.isInteger(code) || code === 0 || surrogate || code > 0x10ffff) {
      throw new XmlParseError('Bad character reference');
    }
    return String.fromCodePoint(code);
  });
}

const localName = (qualified: string): string => qualified.slice(qualified.indexOf(':') + 1);

interface OpenTag {
  readonly qname: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  /** Offset just past the closing `>`. */
  readonly end: number;
}

/** Linear scan of one tag starting at `<`: every character is visited once. */
function scanTag(xml: string, start: number): OpenTag {
  const closing = xml[start + 1] === '/';
  NAME.lastIndex = start + (closing ? 2 : 1);
  const match = NAME.exec(xml);
  if (match === null) throw new XmlParseError(`Bad tag at offset ${String(start)}`);
  const qname = match[0];
  let i = NAME.lastIndex;
  const delimiter = xml.charAt(i);
  if (delimiter === '') throw new XmlParseError('Unterminated tag');
  if (delimiter !== '>' && delimiter !== '/' && !BLANK.test(delimiter)) {
    throw new XmlParseError(`Bad tag name at offset ${String(start)}`);
  }
  const attributesStart = i;
  while (i < xml.length) {
    const c = xml[i];
    if (c === '>') {
      if (closing && xml.slice(attributesStart, i).trim() !== '') {
        throw new XmlParseError('A closing tag cannot have attributes');
      }
      return { qname, closing, selfClosing: xml[i - 1] === '/' && !closing, end: i + 1 };
    }
    if (c === '<') throw new XmlParseError(`Unexpected "<" inside a tag at offset ${String(i)}`);
    if (c === '"' || c === "'") {
      const close = xml.indexOf(c, i + 1);
      if (close === -1) throw new XmlParseError('Unterminated attribute value');
      i = close + 1;
    } else {
      i += 1;
    }
  }
  throw new XmlParseError('Unterminated tag');
}

/** Index just past `terminator`, searching from `from`. */
function skipPast(xml: string, terminator: string, from: number): number {
  const index = xml.indexOf(terminator, from);
  if (index === -1) throw new XmlParseError(`Missing "${terminator}"`);
  return index + terminator.length;
}

/**
 * Minimal, strict XML reader for SIFEN SOAP responses. It rejects DOCTYPE/entity declarations
 * (no XXE or entity expansion), resolves only the five predefined and valid numeric entities, caps
 * nesting depth, and requires exactly one root element. It is a hand-written scanner that visits each
 * character a bounded number of times, so adversarial input cannot cost more than linear time.
 * @throws XmlParseError on anything malformed
 */
export function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new XmlParseError('DTDs are not allowed');
  const stack: { node: XmlNode; start: number; qname: string }[] = [];
  let root: XmlNode | undefined;
  let position = 0;

  while (position < xml.length) {
    const start = position;
    const top = stack.at(-1);

    if (xml[start] !== '<') {
      const next = xml.indexOf('<', start);
      const end = next === -1 ? xml.length : next;
      const raw = xml.slice(start, end);
      if (top !== undefined) top.node.text += decode(raw);
      else if (raw.trim() !== '')
        throw new XmlParseError('Character data outside the root element');
      position = end;
    } else if (xml.startsWith('<!--', start)) {
      position = skipPast(xml, '-->', start + 4);
    } else if (xml.startsWith('<?', start)) {
      position = skipPast(xml, '?>', start + 2);
    } else if (xml.startsWith('<![CDATA[', start)) {
      if (top === undefined) throw new XmlParseError('Character data outside the root element');
      const end = skipPast(xml, ']]>', start + 9);
      top.node.text += xml.slice(start + 9, end - 3);
      position = end;
    } else if (xml.startsWith('<!', start)) {
      throw new XmlParseError(`Unsupported markup at offset ${String(start)}`);
    } else {
      const tag = scanTag(xml, start);
      position = tag.end;
      if (tag.closing) {
        if (top === undefined || top.qname !== tag.qname) {
          throw new XmlParseError(`Unexpected closing tag </${tag.qname}>`);
        }
        top.node.raw = xml.slice(top.start, position);
        stack.pop();
        continue;
      }
      if (top === undefined && root !== undefined)
        throw new XmlParseError('More than one root element');
      if (stack.length >= MAX_DEPTH) throw new XmlParseError('Document is nested too deeply');
      const node: XmlNode = { name: localName(tag.qname), children: [], text: '', raw: '' };
      if (top === undefined) root = node;
      else top.node.children.push(node);
      if (tag.selfClosing) node.raw = xml.slice(start, position);
      else stack.push({ node, start, qname: tag.qname });
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
