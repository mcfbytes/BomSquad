/**
 * The streaming XML scanner.
 *
 * MAME's listxml is regular enough that a scanner could get away with a great deal, so
 * these tests are mostly about the constructs it is *allowed* to be lazy about and is not:
 * a `<!DOCTYPE>` whose internal subset is full of `>` characters, entity references in
 * both attributes and text, quotes nested inside the other kind of quote, and — the one
 * that only a streaming parser can get wrong — the same document fed one byte at a time.
 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';

import {
  decodeEntities,
  parseAttributes,
  scanXml,
  streamXml,
  type XmlHandler,
} from '../src/mame/xml.js';

/** Records every event as a printable line, so an assertion reads as a transcript. */
function transcript(): { readonly lines: string[]; readonly handler: XmlHandler } {
  const lines: string[] = [];
  return {
    lines,
    handler: {
      onOpen(name, source, start, end, selfClosing): void {
        lines.push(`open ${name} [${source.slice(start, end).trim()}]${selfClosing ? ' /' : ''}`);
      },
      onClose(name): void {
        lines.push(`close ${name}`);
      },
      onText(source, start, end): void {
        lines.push(`text ${JSON.stringify(source.slice(start, end))}`);
      },
    },
  };
}

function scanAll(xml: string): string[] {
  const { lines, handler } = transcript();
  const consumed = scanXml(xml, true, handler);
  expect(consumed).toBe(xml.length);
  return lines;
}

describe('entity references', () => {
  it('resolves the five named entities XML predefines', () => {
    expect(decodeEntities('a &amp; b &lt; c &gt; d &quot;e&quot; f &apos;g&apos;')).toBe(
      `a & b < c > d "e" f 'g'`,
    );
  });

  it('resolves decimal and hexadecimal character references', () => {
    expect(decodeEntities('&#65;&#x42;&#x1F600;')).toBe('AB\u{1F600}');
  });

  it('leaves an undeclared entity verbatim rather than deleting the datum', () => {
    // Losing '&nosuch;' silently would corrupt a machine name with nothing to show for it.
    expect(decodeEntities('Sega &nosuch; Co')).toBe('Sega &nosuch; Co');
  });

  it('returns the same string when there is nothing to decode', () => {
    expect(decodeEntities('plain text')).toBe('plain text');
  });
});

describe('attribute parsing', () => {
  it('reads double- and single-quoted values and decodes them', () => {
    expect([...parseAttributes(` name="a &amp; b" tag='c&lt;d' clock="10000000"`)]).toEqual([
      ['name', 'a & b'],
      ['tag', 'c<d'],
      ['clock', '10000000'],
    ]);
  });

  it('tolerates whitespace around the equals sign and newlines between attributes', () => {
    expect([...parseAttributes('a = "1"\n\tb="2"')]).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('keeps a quote of the other kind inside a value', () => {
    expect(parseAttributes(`name="it's fine" other='say "hi"'`).get('name')).toBe("it's fine");
    expect(parseAttributes(`name="it's fine" other='say "hi"'`).get('other')).toBe('say "hi"');
  });
});

describe('scanning', () => {
  it('reports start tags, end tags and non-blank text', () => {
    expect(scanAll('<a x="1"><b>hello</b></a>')).toEqual([
      'open a [x="1"]',
      'open b []',
      'text "hello"',
      'close b',
      'close a',
    ]);
  });

  it('marks a self-closing tag and does not fabricate an end tag for it', () => {
    expect(scanAll('<a><b x="1"/></a>')).toEqual(['open a []', 'open b [x="1"] /', 'close a']);
  });

  it('drops the whitespace between elements that pretty-printed XML is full of', () => {
    expect(scanAll('<a>\n\t<b/>\n</a>\n')).toEqual(['open a []', 'open b [] /', 'close a']);
  });

  it('skips the XML declaration and comments', () => {
    expect(scanAll('<?xml version="1.0"?><!-- <a/> is not real --><a/>')).toEqual(['open a [] /']);
  });

  it('skips a DOCTYPE whose internal subset is full of angle brackets', () => {
    // Stopping at the first '>' would leave the scanner inside the DTD, where it would
    // read '<!ATTLIST machine name …' as an element called '!ATTLIST'.
    const xml = `<!DOCTYPE mame [
<!ELEMENT mame (machine+)>
	<!ATTLIST machine name CDATA #REQUIRED>
]>
<mame/>`;
    expect(scanAll(xml)).toEqual(['open mame [] /']);
  });

  it('treats CDATA as literal text, entity references included', () => {
    expect(scanAll('<a><![CDATA[Taito & Co <not a tag>]]></a>')).toEqual([
      'open a []',
      'text "Taito & Co <not a tag>"',
      'close a',
    ]);
  });

  it('finds the tag end past a raw > inside an attribute value', () => {
    expect(scanAll('<a name="1 > 0"><b/></a>')).toEqual([
      'open a [name="1 > 0"]',
      'open b [] /',
      'close a',
    ]);
  });
});

describe('incremental scanning', () => {
  it('consumes nothing of a tag that is not complete yet', () => {
    const { lines, handler } = transcript();
    expect(scanXml('<a><b x="1', false, handler)).toBe(3);
    expect(lines).toEqual(['open a []']);
  });

  it('holds a text run back until a following tag proves it is whole', () => {
    // Emitting 'hel' and then 'lo' would make <description> arrive in two pieces, and the
    // machine parser assigns rather than appends.
    const { lines, handler } = transcript();
    expect(scanXml('<a>hel', false, handler)).toBe(3);
    expect(lines).toEqual(['open a []']);
    expect(scanXml('<a>hello</a>', false, handler)).toBe(12);
    expect(lines).toEqual(['open a []', 'open a []', 'text "hello"', 'close a']);
  });

  it('emits a trailing text run once the document has ended', () => {
    const { lines, handler } = transcript();
    scanXml('<a>tail', true, handler);
    expect(lines).toEqual(['open a []', 'text "tail"']);
  });
});

describe('streaming a byte source', () => {
  const document = `<?xml version="1.0"?>
<!DOCTYPE mame [<!ELEMENT mame (machine+)>]>
<mame build="0.288">
	<machine name="zeta"><description>Zeta &amp; Sons</description></machine>
</mame>`;

  /** Splits into `size`-byte chunks to force every construct across a boundary. */
  function chunked(text: string, size: number): Readable {
    const bytes = Buffer.from(text, 'utf8');
    const parts: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += size) parts.push(bytes.subarray(at, at + size));
    return Readable.from(parts);
  }

  it('produces the same events whatever the chunk size', async () => {
    const whole = scanAll(document);
    for (const size of [1, 2, 3, 7, 64, 4096]) {
      const { lines, handler } = transcript();
      await streamXml(chunked(document, size), handler);
      expect(lines, `chunk size ${size}`).toEqual(whole);
    }
  });

  it('reassembles a multi-byte character split across two reads', async () => {
    const { lines, handler } = transcript();
    const bytes = Buffer.from('<a>\u{1F600}</a>', 'utf8');
    await streamXml(Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]), handler);
    expect(lines).toEqual(['open a []', 'text "\u{1F600}"', 'close a']);
  });

  it('refuses a truncated document instead of silently returning what it read', async () => {
    await expect(
      streamXml(Readable.from([Buffer.from('<a><b x="1')]), transcript().handler),
    ).rejects.toThrow(/left unparsed at end of document/);
  });
});
