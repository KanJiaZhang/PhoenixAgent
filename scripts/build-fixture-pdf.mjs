#!/usr/bin/env node
/**
 * Writes the demo's PDF fixture.
 *
 * The file has to be a *real* PDF (a page, a font, a content stream, an xref-free trailer) so the reader is
 * exercised rather than mocked, and it has to contain Chinese, which is the hard part: a Latin-1 byte stream
 * cannot carry 中文, so the text is written as two-byte glyph codes and the font declares a `/ToUnicode`
 * CMap that maps each code to its character. That is exactly the mechanism the reader implements, and it is
 * how real Chinese PDFs are built.
 *
 * The content stream is Flate-compressed on purpose: the reader's inflate path is the path that runs on every
 * real document.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const lines = [
  '投放与口径补充（PDF 版）',
  '',
  '本页是口径手册的补充，语义层从这份 PDF 的文本层读取指标定义。',
  '',
  '## 指标口径补充',
  '',
  '- 投放花费（spend）：媒体后台扣费，含税不含返点；月度对账以财务确认口径为准。',
  '- 归因收入（revenue）：7 天点击归因窗口内的支付金额，跨渠道存在归因重叠，不能直接相加。',
  '- ROI（投入产出比）：归因收入除以投放花费，分母为 0 时口径为空。',
  '',
  '## 维度补充',
  '',
  '- 渠道（channel）：搜索、信息流、直播；直播的转化周期最长，同比分析要按渠道分别对齐。',
];

// --- one code per character, so a line is a sequence of two-byte glyph codes
const characters = [...new Set(lines.join(''))].filter((character) => character !== '\n');
const codeOf = new Map(characters.map((character, index) => [character, index + 1]));

const hex4 = (value) => value.toString(16).toUpperCase().padStart(4, '0');

const cmapLines = [
  '/CIDInit /ProcSet findresource begin',
  '12 dict begin',
  'begincmap',
  '/CMapName /PhoenixAgentFixture def',
  '/CMapType 2 def',
  '1 begincodespacerange',
  '<0000> <FFFF>',
  'endcodespacerange',
  `${characters.length} beginbfchar`,
  ...characters.map((character) => `<${hex4(codeOf.get(character))}> <${hex4(character.codePointAt(0))}>`),
  'endbfchar',
  'endcmap',
  'CMapName currentdict /CMap defineresource pop',
  'end',
  'end',
];
const cmap = cmapLines.join('\n');

const contentParts = ['BT', '/F1 11 Tf'];
let y = 780;
for (const line of lines) {
  if (line.length === 0) {
    y -= 10;
    continue;
  }
  const codes = [...line].map((character) => hex4(codeOf.get(character))).join('');
  const size = line.startsWith('##') ? 14 : 11;
  const text = line.replace(/^##\s*/, '');
  const codes2 = [...text].map((character) => hex4(codeOf.get(character))).join('');
  contentParts.push(`/F1 ${size} Tf 1 0 0 1 50 ${y} Tm <${codes2}> Tj`);
  y -= size + 8;
  void codes;
}
contentParts.push('ET');
const content = contentParts.join('\n');
const compressed = deflateSync(Buffer.from(content, 'latin1'));

const objects = [];
objects.push('<< /Type /Catalog /Pages 2 0 R >>');
objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
  + '/Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>');
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >>');

const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
const addObject = (number, body, stream) => {
  chunks.push(Buffer.from(`${number} 0 obj\n${body}\n`, 'latin1'));
  if (stream) {
    chunks.push(Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1'));
  }
  chunks.push(Buffer.from('endobj\n', 'latin1'));
};

addObject(1, objects[0]);
addObject(2, objects[1]);
addObject(3, objects[2]);
addObject(4, objects[3]);
addObject(5, `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>`, Buffer.from(cmap, 'latin1'));
addObject(6, `<< /Length ${compressed.length} /Filter /FlateDecode >>`, compressed);
chunks.push(Buffer.from(`trailer\n<< /Size 7 /Root 1 0 R >>\n%%EOF\n`, 'latin1'));

const target = join(process.cwd(), 'fixtures', 'demo', 'docs', '指标口径补充.pdf');
mkdirSync(join(process.cwd(), 'fixtures', 'demo', 'docs'), { recursive: true });
writeFileSync(target, Buffer.concat(chunks));
console.log(`wrote ${target} (${Buffer.concat(chunks).length} bytes, ${characters.length} glyphs)`);
