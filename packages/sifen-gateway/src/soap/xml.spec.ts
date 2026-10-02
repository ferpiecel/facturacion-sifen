import { describe, expect, it } from 'vitest';
import { XmlParseError, childText, children, firstChild, parseXml } from './xml.ts';

describe('parseXml', () => {
  it('parses nested elements, ignoring prefixes, attributes, comments and the declaration', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!-- c --><a:r xmlns:a="u" x="1"><a:k>v &lt;1&gt; &#65;</a:k><k/></a:r>',
    );

    expect(root.name).toBe('r');
    expect(children(root, 'k').map((k) => k.text)).toEqual(['v <1> A', '']);
    expect(childText(root, 'k')).toBe('v <1> A');
  });

  it('keeps CDATA content verbatim and exposes the raw source of an element', () => {
    const root = parseXml('<r><x><![CDATA[<b>&</b>]]></x><y><z a="1">t</z></y></r>');

    expect(childText(root, 'x')).toBe('<b>&</b>');
    expect(firstChild(root, 'y')?.raw).toBe('<y><z a="1">t</z></y>');
  });

  it.each([
    ['a DOCTYPE', '<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>'],
    ['an unknown entity', '<r>&e;</r>'],
    ['a mismatched close tag', '<r><a></b></r>'],
    ['an unclosed element', '<r><a>'],
    ['trailing content', '<r/><s/>'],
    ['no root', '   '],
    ['text outside the root', 'x<r/>'],
  ])('rejects %s', (_label, xml) => {
    expect(() => parseXml(xml)).toThrow(XmlParseError);
  });

  it('rejects documents nested deeper than the limit', () => {
    const deep = '<a>'.repeat(200) + '</a>'.repeat(200);
    expect(() => parseXml(deep)).toThrow(XmlParseError);
  });
});
