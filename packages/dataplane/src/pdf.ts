/**
 * A PDF reader, because "the metric book is a PDF" is the normal case in an enterprise.
 *
 * It does the two things a text-layer PDF needs and stops there: inflate the content streams, and map the
 * bytes of each text string through the font's `/ToUnicode` CMap when the file has one. That mapping is the
 * whole reason this works on Chinese documents - a CID font's bytes are glyph ids, and only the CMap knows
 * they mean 中, 文. Without a CMap the bytes are decoded as Latin-1 and the text is reported as unread if it
 * does not look like language.
 *
 * What it does **not** do: OCR (an image-only PDF is unreadable, and says so), layout recovery (a two-column
 * page reads in stream order), or table reconstruction (cells come out as words in reading order, and the
 * document reader's line patterns are what make sense of them).
 *
 * The point of the honesty checks at the bottom is that a wrong sentence is worse than a missing one: if the
 * extracted text is mostly non-letters, the file is reported as unread rather than fed to the extractor,
 * where garbled text would become confident garbage in the model.
 */

import { inflateSync } from 'node:zlib';

export interface PdfPage {
  index: number;
  text: string;
}

export interface PdfExtraction {
  pages: PdfPage[];
  text: string;
  readable: boolean;
  /** Why it is not readable, or what was approximated. Empty when the text came out clean. */
  note: string;
}

interface PdfObject {
  number: number;
  dict: string;
  stream?: Buffer;
}

/** Reads a PDF buffer into text. Never throws on a malformed file: it reports. */
export function extractPdfText(buffer: Buffer): PdfExtraction {
  try {
    return extract(buffer);
  } catch (error) {
    return { pages: [], text: '', readable: false, note: `the PDF could not be parsed: ${(error as Error).message}` };
  }
}

function extract(buffer: Buffer): PdfExtraction {
  // PDF syntax is ASCII with byte-exact streams, so latin1 is the right lens: one char per byte.
  const raw = buffer.toString('latin1');
  const objects = readObjects(raw);
  const cmaps = readCMaps(objects);

  const pages: PdfPage[] = [];
  const pageObjects = [...objects.values()].filter((object) => /\/Type\s*\/Page[^s]/.test(object.dict));
  const contents = pageObjects.length > 0
    ? pageObjects.map((page) => ({ index: pages.length, ...contentOf(page, objects) }))
    : [...objects.values()]
      .filter((object) => object.stream && !isCMap(object))
      .map((object) => ({ index: 0, ...contentOf(object, objects) }));

  for (const content of contents) {
    const text = decodeContent(content.data ?? '', cmaps);
    if (text.trim().length > 0) pages.push({ index: pages.length, text: normalize(text) });
  }

  const text = pages.map((page) => page.text).join('\n');
  const quality = readability(text);
  return {
    pages,
    text,
    readable: quality.readable,
    note: quality.note,
  };
}

function readObjects(raw: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const pattern = /(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g;
  for (const match of raw.matchAll(pattern)) {
    const number = Number(match[1]);
    const body = match[2] ?? '';
    const streamStart = body.indexOf('stream');
    let dict = body;
    let stream: Buffer | undefined;
    if (streamStart >= 0) {
      dict = body.slice(0, streamStart);
      // `stream` is followed by CRLF or LF
      let start = streamStart + 'stream'.length;
      if (body[start] === '\r') start++;
      if (body[start] === '\n') start++;
      const end = body.indexOf('endstream', start);
      const bytes = body.slice(start, end < 0 ? body.length : end);
      stream = Buffer.from(bytes, 'latin1');
    }
    objects.set(number, { number, dict, stream });
  }
  return objects;
}

/** Every `/ToUnicode N 0 R` target, decompressed and parsed into one byte-to-text map. */
function readCMaps(objects: Map<number, PdfObject>): Map<string, string> {
  const cmap = new Map<string, string>();
  for (const object of objects.values()) {
    const reference = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(object.dict);
    if (!reference) continue;
    const target = objects.get(Number(reference[1]));
    if (!target) continue;
    const text = inflateIfNeeded(target)?.toString('latin1') ?? '';
    for (const [key, value] of parseCMap(text)) cmap.set(key, value);
  }
  // A file with no /ToUnicode reference may still embed one; scan for the operators as a fallback.
  if (cmap.size === 0) {
    for (const object of objects.values()) {
      if (!object.stream) continue;
      const text = inflateIfNeeded(object)?.toString('latin1') ?? '';
      if (text.includes('beginbfchar') || text.includes('beginbfrange')) {
        for (const [key, value] of parseCMap(text)) cmap.set(key, value);
      }
    }
  }
  return cmap;
}

function parseCMap(text: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(pair[1]!.toUpperCase(), decodeUtf16Hex(pair[2]!));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const entry of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const low = parseInt(entry[1]!, 16);
      const high = parseInt(entry[2]!, 16);
      const width = entry[1]!.length;
      const destination = entry[3]!;
      if (destination.startsWith('[')) {
        const values = [...destination.matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => decodeUtf16Hex(m[1]!));
        values.forEach((value, offset) => {
          if (low + offset <= high) map.set(hex(low + offset, width), value);
        });
      } else {
        const base = [...destination.matchAll(/<([0-9A-Fa-f]+)>/g)][0]?.[1] ?? '';
        const baseCodeUnits = hexToCodeUnits(base);
        for (let code = low; code <= high && code - low < 65536; code++) {
          const shifted = [...baseCodeUnits];
          shifted[shifted.length - 1] = (shifted[shifted.length - 1] ?? 0) + (code - low);
          map.set(hex(code, width), String.fromCharCode(...shifted));
        }
      }
    }
  }
  return map;
}

function contentOf(object: PdfObject, objects: Map<number, PdfObject>): { data?: string } {
  const referenced = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(object.dict);
  if (referenced) {
    const contentObject = objects.get(Number(referenced[1]));
    const bytes = contentObject ? inflateIfNeeded(contentObject) : undefined;
    if (bytes) return { data: bytes.toString('latin1') };
  }
  const bytes = inflateIfNeeded(object);
  return { data: bytes?.toString('latin1') };
}

function isCMap(object: PdfObject): boolean {
  const text = inflateIfNeeded(object)?.toString('latin1') ?? '';
  return text.includes('beginbfchar') || text.includes('beginbfrange');
}

function inflateIfNeeded(object: PdfObject): Buffer | undefined {
  if (!object.stream) return undefined;
  if (!/FlateDecode/.test(object.dict)) return object.stream;
  try {
    return inflateSync(object.stream);
  } catch {
    return undefined;
  }
}

/**
 * Decodes the text operators of one content stream.
 *
 * Handles `(...) Tj`, `[...] TJ`, `'` and `"`, hex strings `<...>`, and treats `Td`/`TD`/`T*` as line breaks.
 * A string is mapped through the CMap two bytes at a time when the CMap is 2-byte keyed (which is the normal
 * case for CJK), one byte at a time otherwise.
 */
function decodeContent(content: string, cmap: Map<string, string>): string {
  const codeWidth = cmap.size === 0 ? 0 : Math.max(...[...cmap.keys()].map((key) => key.length));
  let out = '';
  let i = 0;

  const readString = (): { text: string; end: number } | null => {
    if (content[i] === '(') {
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < content.length && depth > 0) {
        const ch = content[j]!;
        if (ch === '\\') {
          const next = content[j + 1];
          raw += next === undefined ? '' : unescapePdf(next);
          j += 2;
          continue;
        }
        if (ch === '(') depth++;
        if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
        raw += ch;
        j++;
      }
      return { text: decodeBytes(Buffer.from(raw, 'latin1'), cmap, codeWidth), end: j + 1 };
    }
    if (content[i] === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end < 0) return null;
      const hexText = content.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
      const bytes = Buffer.from(hexText.length % 2 === 0 ? hexText : `${hexText}0`, 'hex');
      return { text: decodeBytes(bytes, cmap, codeWidth), end: end + 1 };
    }
    return null;
  };

  while (i < content.length) {
    const ch = content[i]!;
    if (ch === '(' || (ch === '<' && content[i + 1] !== '<')) {
      const string = readString();
      if (!string) {
        i++;
        continue;
      }
      out += string.text;
      i = string.end;
      continue;
    }
    // Td/TD/T* move the text cursor; Tm sets the whole matrix, which is what generators emit per line -
    // either way a new line starts, and losing it would glue every sentence in the document together
    if (ch === 'T' && (content[i + 1] === 'd' || content[i + 1] === 'D' || content[i + 1] === '*' || content[i + 1] === 'm')) {
      out += '\n';
      i += 2;
      continue;
    }
    if (ch === 'T' && content[i + 1] === 'J') {
      out += ' ';
      i += 2;
      continue;
    }
    i++;
  }
  return out;
}

function decodeBytes(bytes: Buffer, cmap: Map<string, string>, codeWidth: number): string {
  if (cmap.size === 0 || codeWidth === 0) return bytes.toString('latin1');
  const width = Math.max(2, codeWidth / 2);
  let out = '';
  for (let i = 0; i + width <= bytes.length; i += width) {
    const key = bytes.subarray(i, i + width).toString('hex').toUpperCase();
    out += cmap.get(key) ?? '';
  }
  return out;
}

function unescapePdf(character: string): string {
  switch (character) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'b': return '\b';
    case 'f': return '\f';
    case '(': return '(';
    case ')': return ')';
    case '\\': return '\\';
    default: return character;
  }
}

function normalize(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]?.length !== 0))
    .join('\n')
    .trim();
}

/** Is this text language, or glyph soup? Under half letters is not something to feed a model. */
function readability(text: string): { readable: boolean; note: string } {
  const characters = [...text].filter((character) => !/\s/.test(character));
  if (characters.length === 0) {
    return { readable: false, note: 'no text layer found (an image-only scan needs OCR, which this build does not do)' };
  }
  const letters = characters.filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  const ratio = letters / characters.length;
  if (ratio < 0.5) {
    return { readable: false, note: `the text layer decodes to mostly non-language (${(ratio * 100).toFixed(0)}% letters); a font without a ToUnicode map needs OCR` };
  }
  return { readable: true, note: '' };
}

function decodeUtf16Hex(value: string): string {
  return String.fromCharCode(...hexToCodeUnits(value));
}

function hexToCodeUnits(value: string): number[] {
  const units: number[] = [];
  for (let i = 0; i + 4 <= value.length; i += 4) units.push(parseInt(value.slice(i, i + 4), 16));
  return units.length > 0 ? units : [parseInt(value, 16) || 0];
}

function hex(code: number, width: number): string {
  return code.toString(16).toUpperCase().padStart(width, '0');
}
