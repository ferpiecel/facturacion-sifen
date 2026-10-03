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
    ['a closing tag with attributes', '<r></r x="1">'],
    ['a NUL character reference', '<r>&#0;</r>'],
    ['a lone surrogate reference', '<r>&#xD800;</r>'],
    ['a reference past U+10FFFF', '<r>&#x110000;</r>'],
    ['a bare ampersand', '<r>a & b</r>'],
    ['a tag name without a delimiter', '<r><a'],
    ['a less-than inside a tag', '<r><a b<c></a></r>'],
  ])('rejects %s', (_label, xml) => {
    expect(() => parseXml(xml)).toThrow(XmlParseError);
  });

  it('rejects documents nested deeper than the limit', () => {
    const deep = '<a>'.repeat(200) + '</a>'.repeat(200);
    expect(() => parseXml(deep)).toThrow(XmlParseError);
  });
});

describe('parseXml on adversarial input', () => {
  const MB = 'a'.repeat(1_000_000);
  it.each([
    ['an unterminated tag name', `<r><${MB}`],
    ['repeated unterminated tags', `<r>x${'<x'.repeat(500_000)}`],
    ['an unterminated attribute run', `<r><a ${'b="c" '.repeat(160_000)}`],
    ['an unterminated comment', `<r><!--${MB}`],
  ])('fails in linear time on %s', (_label, xml) => {
    const started = performance.now();
    expect(() => parseXml(xml)).toThrow(XmlParseError);
    // ~1-5 ms locally; the old quadratic scanner took hours at this size. The
    // generous bound keeps the guard while tolerating loaded CI runners.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
