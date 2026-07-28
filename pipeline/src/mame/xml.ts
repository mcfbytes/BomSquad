/**
 * A streaming XML tag scanner, sized for one job: MAME's `-listxml` output.
 *
 * **Why hand-rolled.** listxml is machine-generated from a DTD that ships in the file's
 * own prologue: no namespaces, no mixed content, no processing instructions past the XML
 * declaration, no comments, no CDATA, attributes always double-quoted. A general XML
 * parser would spend its budget on constructs this document cannot contain, and adding
 * one costs a runtime dependency the repository does not otherwise have. What is *not*
 * skipped is correctness on the constructs that could appear: entity references
 * (`&amp; &lt; &gt; &quot; &apos;` and numeric character references), single-quoted
 * attribute values, self-closing tags, comments, CDATA sections, the `<?xml?>`
 * declaration, and a `<!DOCTYPE>` with an internal subset — all handled, all tested.
 *
 * **Why the handler takes offsets instead of strings.** The full 0.288 document is 309 MB
 * and roughly five million elements, of which four kinds matter. Materialising a name, an
 * attribute string and a text node for every element would allocate tens of millions of
 * short-lived strings to throw almost all of them away. {@link XmlHandler} is therefore
 * handed the scanner's own buffer plus a range, and slices only what it keeps. That single
 * decision is the difference between a parse measured in minutes and one measured in
 * seconds, and it is why {@link streamXml} holds a fixed-size window rather than the
 * document.
 *
 * **Memory model.** {@link scanXml} consumes only *complete* constructs and returns how
 * many characters it used; {@link streamXml} drops that prefix and appends the next chunk.
 * The live buffer is therefore one read chunk plus at most one unfinished element — tens
 * of kilobytes, independent of document size.
 */
import type { Readable } from 'node:stream';

/**
 * Receives scanner events. Every callback is handed `source` plus a half-open range into
 * it; the range is only valid for the duration of the call.
 */
export interface XmlHandler {
  /**
   * A start tag. `source.slice(attributesStart, attributesEnd)` is the raw, still-encoded
   * attribute text — pass it to {@link parseAttributes} only for elements you keep.
   */
  readonly onOpen: (
    name: string,
    source: string,
    attributesStart: number,
    attributesEnd: number,
    selfClosing: boolean,
  ) => void;
  /** An end tag. Self-closing start tags do **not** produce one; check `selfClosing`. */
  readonly onClose: (name: string) => void;
  /** A character-data run, still encoded. Whitespace-only runs are never reported. */
  readonly onText: (source: string, start: number, end: number) => void;
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;

/**
 * Resolves XML entity and character references.
 *
 * An **unrecognised** entity is left verbatim rather than raising. listxml declares no
 * custom entities, so an unknown one means the document is not what this scanner was
 * built for; passing the text through keeps the datum visible in the extract, where a
 * curator will see it, instead of failing a 300 MB parse over one string or — far worse —
 * silently deleting the reference and shipping a corrupted machine name.
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (whole: string, body: string) => {
    if (!body.startsWith('#')) return NAMED_ENTITIES.get(body) ?? whole;
    const code =
      body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

const ATTRIBUTE = /([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

/**
 * Parses one start tag's raw attribute text into `name → decoded value`.
 *
 * Deliberately *not* called by the scanner: see the module comment. Duplicate attribute
 * names — which XML forbids and listxml never emits — resolve last-wins rather than
 * throwing, because a duplicate is a document defect and losing the whole machine over it
 * would be a worse outcome than keeping one of the two values.
 */
export function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  for (let match = ATTRIBUTE.exec(raw); match !== null; match = ATTRIBUTE.exec(raw)) {
    const [, name, , doubleQuoted, singleQuoted] = match;
    if (name !== undefined) {
      attributes.set(name, decodeEntities(doubleQuoted ?? singleQuoted ?? ''));
    }
  }
  return attributes;
}

/** Space, tab, CR or LF — the only whitespace XML recognises outside character data. */
function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** True when `text[start, end)` is entirely whitespace, without allocating a slice. */
function isBlank(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (!isSpace(text.charCodeAt(index))) return false;
  }
  return true;
}

/**
 * The index of the `>` that closes a tag starting at `start`, or -1 if the tag is not
 * complete in `text`.
 *
 * A raw `>` is legal inside an attribute value, so the search cannot be a plain
 * `indexOf('>')`. It is also not a character loop: stepping over quoted spans with
 * `indexOf` keeps the whole scan inside native string search, which is most of why this
 * parser reads 309 MB in seconds.
 */
function findTagEnd(text: string, start: number): number {
  let index = start;
  for (;;) {
    const gt = text.indexOf('>', index);
    if (gt < 0) return -1;
    const double = text.indexOf('"', index);
    const single = text.indexOf("'", index);
    const quote = double < 0 ? single : single < 0 ? double : Math.min(double, single);
    const character = quote < 0 ? undefined : text[quote];
    if (character === undefined || quote > gt) return gt;
    const close = text.indexOf(character, quote + 1);
    if (close < 0) return -1;
    index = close + 1;
  }
}

/** The end of the element name that starts at `start` (just past `<` or `</`). */
function findNameEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isSpace(code) || code === 47 /* / */ || code === 62 /* > */) break;
    index += 1;
  }
  return index;
}

/**
 * Skips a `<!DOCTYPE …>` declaration, including an internal subset.
 *
 * The subset is bracket-delimited and MAME's is ten kilobytes of `<!ELEMENT>` and
 * `<!ATTLIST>` declarations, each containing a `>`. Stopping at the first `>` would drop
 * the scanner into the middle of the DTD and it would then read `<!ATTLIST machine name …`
 * as an element. Returns -1 when the declaration is not complete in `text`.
 */
function findDeclarationEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '[') depth += 1;
    else if (character === ']') depth -= 1;
    else if (character === '>' && depth <= 0) return index;
  }
  return -1;
}

/**
 * Scans every **complete** construct at the front of `text` and returns how many
 * characters were consumed. A trailing partial tag is left for the next call.
 *
 * `atEnd` says no more input is coming, which is the only thing that distinguishes "a
 * text run that may continue" from "the last text run in the document".
 */
export function scanXml(text: string, atEnd: boolean, handler: XmlHandler): number {
  let position = 0;
  for (;;) {
    if (position >= text.length) return position;

    const lt = text.indexOf('<', position);
    if (lt < 0) {
      // Character data with no following tag. Unless the document has ended it may
      // continue in the next chunk, so it is not consumed — a text node must reach the
      // handler once, whole, or `<description>` would arrive in pieces.
      if (!atEnd) return position;
      if (!isBlank(text, position, text.length)) handler.onText(text, position, text.length);
      return text.length;
    }
    if (lt > position && !isBlank(text, position, lt)) handler.onText(text, position, lt);
    position = lt;

    if (text.startsWith('<!--', position)) {
      const end = text.indexOf('-->', position + 4);
      if (end < 0) return position;
      position = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', position)) {
      const end = text.indexOf(']]>', position + 9);
      if (end < 0) return position;
      // CDATA content is literal: entity references inside it are not references.
      if (!isBlank(text, position + 9, end)) handler.onText(text, position + 9, end);
      position = end + 3;
      continue;
    }
    if (text.startsWith('<?', position)) {
      const end = text.indexOf('?>', position + 2);
      if (end < 0) return position;
      position = end + 2;
      continue;
    }
    if (text.startsWith('<!', position)) {
      const end = findDeclarationEnd(text, position + 2);
      if (end < 0) return position;
      position = end + 1;
      continue;
    }
    if (text.startsWith('</', position)) {
      const end = findTagEnd(text, position + 2);
      if (end < 0) return position;
      handler.onClose(text.slice(position + 2, findNameEnd(text, position + 2)));
      position = end + 1;
      continue;
    }

    const end = findTagEnd(text, position + 1);
    if (end < 0) return position;
    const nameEnd = findNameEnd(text, position + 1);
    const selfClosing = text.charCodeAt(end - 1) === 47; /* / */
    handler.onOpen(
      text.slice(position + 1, nameEnd),
      text,
      nameEnd,
      selfClosing ? end - 1 : end,
      selfClosing,
    );
    position = end + 1;
  }
}

/**
 * Drives {@link scanXml} over a byte stream.
 *
 * The `TextDecoder` runs in streaming mode so a multi-byte UTF-8 sequence split across two
 * reads is reassembled rather than turned into replacement characters — MAME descriptions
 * carry accented Latin, CJK and the occasional emoji-adjacent symbol, and a lost byte
 * there would corrupt a machine name in a way nothing downstream could detect.
 */
export async function streamXml(source: Readable, handler: XmlHandler): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of source) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    const consumed = scanXml(buffer, false, handler);
    if (consumed > 0) buffer = buffer.slice(consumed);
  }
  buffer += decoder.decode();
  const consumed = scanXml(buffer, true, handler);
  const remainder = buffer.slice(consumed).trim();
  if (remainder !== '') {
    throw new Error(
      `xml: ${remainder.length} characters left unparsed at end of document, starting ` +
        `'${remainder.slice(0, 60)}'. The document is truncated or malformed.`,
    );
  }
}
