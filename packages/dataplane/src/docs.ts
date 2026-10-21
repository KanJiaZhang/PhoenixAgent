/**
 * Reads what a business document says about metrics, in the shapes documents actually use.
 *
 * Two kinds of reading happen here, and they are kept apart on purpose:
 *
 * - **Deterministic** patterns (`GMV = SUM(amount - refund_amount)`, `- **ROI（又称 投入产出比）**：...`,
 *   `ROI 由 归因收入 与 投放花费 共同决定`). These need no model, they are reproducible, and they are what
 *   the offline mode (`PAGENT_LLM=none`) still produces.
 * - **Model-assisted** reading, which the caller adds on top (see `extract/docs-llm.ts`). It proposes
 *   candidates with `provenance: 'llm'` and a lower confidence, and it can never turn a claim into an
 *   accepted fact without either a probe or a human.
 *
 * Every mention carries its character range in the source file, so the review screen can show the sentence
 * a claim rests on. A mention whose name matches no metric and no dimension is *not* dropped: it comes back
 * as `needs_review`, because "the wiki talks about a metric the warehouse has never heard of" is exactly
 * the coverage gap the report is supposed to surface.
 */

export type MentionKind = 'definition' | 'contribution' | 'term';

export interface DocMention {
  kind: MentionKind;
  /** The name as written: `GMV`, `投放花费`, `ROI`. */
  name: string;
  aliases: string[];
  /** The right-hand side of `NAME = ...`, if the document gave one. */
  formula?: string;
  description?: string;
  /** For a contribution sentence: who drives the subject. */
  drivers?: string[];
  /** True when the term sits under a heading that talks about dimensions. */
  dimension: boolean;
  heading: string;
  sourceFile: string;
  span: [number, number];
  quote: string;
}

const ALIAS_PREFIX = /^(?:又称|也叫|也称|又名|别名|俗称|简称|全称|英文名|英文)\s*[:：]?\s*/;

/** Reads one markdown document. `sourceFile` is the fixture-relative path used in evidence. */
export function extractDocMentions(sourceFile: string, text: string): DocMention[] {
  const mentions: DocMention[] = [];
  const lines = splitLines(text);
  let heading = '';

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed.length === 0) continue;

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      heading = headingMatch[2]!.trim();
      continue;
    }
    const dimensionHeading = /维度|切分|分析角度/.test(heading);

    // --- `NAME = expression`
    const formula = /^[-*\s>]*\*{0,2}([^*：:=（(]{1,24}?)\*{0,2}\s*[=＝]\s*(.+)$/.exec(trimmed);
    if (formula) {
      const name = formula[1]!.trim();
      const value = stripBackticks(formula[2]!.trim()).replace(/[。.]$/, '');
      if (looksLikeExpression(value)) {
        mentions.push({
          kind: 'definition',
          name,
          aliases: [],
          formula: value,
          description: value,
          dimension: false,
          heading,
          sourceFile,
          span: [line.start, line.end],
          quote: trimmed,
        });
        continue;
      }
    }

    // --- `**NAME（又称 X、Y）**：description`, optionally with an inline ```NAME = expr``` formula.
    // Bold is optional because a PDF's text layer has no markdown: `- 投放花费（spend）：...` is the same
    // claim written by a person who was not thinking about parsers. A bare `NAME：...` with neither bold nor
    // a parenthetical alias is treated as prose, not as a definition.
    // Bold is stripped rather than matched around the name: the marker can wrap just the name
    // (`**GMV**：`) or the name and its aliases (`**GMV（成交总额）**：`), and a PDF has neither.
    const bold = /\*\*/.test(trimmed);
    const cleaned = trimmed.replace(/\*\*/g, '');
    const term = /^[-*\s>]*([^*：:（(]{1,24}?)\s*(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/.exec(cleaned);
    if (term && (bold || term[2] !== undefined)) {
      const name = term[1]!.trim();
      const description = term[3]!.trim();
      const aliases = term[2] ? parseAliases(term[2]) : [];
      const inlineAliases = aliasesFromText(description);
      const drivers = contributionDrivers(`${name}：${description}`);
      // a formula written inside the sentence is still the definition: `口径为已支付订单，`GMV = SUM(amount-...)``
      // The formula may spell the metric in another language:
      // 「捕获率（capture_rate）：`capture_rate = gmv / revenue`」 is one definition, and requiring the two
      // spellings to be byte-identical would drop it.
      const inline = /`([^`=＝]{1,24})\s*[=＝]\s*([^`]+)`/.exec(description);
      const inlineName = inline ? normalizeInline(inline[1]!) : '';
      const inlineFormula = inline && (inlineName === normalizeInline(name)
        || aliases.some((alias) => normalizeInline(alias) === inlineName))
        ? inline[2]!.trim()
        : undefined;
      mentions.push({
        kind: inlineFormula ? 'definition' : drivers ? 'contribution' : 'term',
        name,
        aliases: unique([...aliases, ...inlineAliases]),
        formula: inlineFormula,
        description,
        drivers: drivers ?? undefined,
        dimension: dimensionHeading || /维度/.test(`${name}${description}`) && /大区|行业|渠道|日期/.test(name),
        heading,
        sourceFile,
        span: [line.start, line.end],
        quote: trimmed,
      });
      continue;
    }

    // --- plain sentences that state a dependency: `ROI 由 归因收入 与 投放花费 共同决定`
    //
    // One line can hold several of these (`A 由 X 与 Y 决定。B 由 Z 与 W 决定。`), and reading the whole line as
    // one sentence makes the first subject own all the drivers. So the line is split on sentence ends first.
    for (const sentence of trimmed.split(/[。；;]/).map((part) => part.trim()).filter((part) => part.length > 0)) {
      const sentenceDrivers = contributionDrivers(sentence);
      if (!sentenceDrivers) continue;
      const subject = subjectOf(sentence);
      if (!subject) continue;
      mentions.push({
        kind: 'contribution',
        name: subject,
        aliases: [],
        drivers: sentenceDrivers,
        dimension: false,
        heading,
        sourceFile,
        span: [line.start, line.end],
        quote: sentence,
      });
    }
  }
  return mentions;
}

/** `A 由 B 与 C 共同决定` -> `[B, C]`; `A 取决于 B 和 C` -> `[B, C]`; anything else -> null. */
export function contributionDrivers(text: string): string[] | null {
  const match = /(.{2,40}?)\s*(?:是)?\s*(?:由|取决于|受)\s*(.{2,60}?)\s*(?:共同)?(?:决定|驱动|影响|构成|拉动)/.exec(text);
  if (!match) return null;
  const drivers = match[2]!
    .split(/与|和|、|及|以及|\+/)
    .map((part) => part.replace(/[的\s]/g, '').trim())
    .filter((part) => part.length > 0);
  return drivers.length >= 1 ? drivers : null;
}

function subjectOf(text: string): string | null {
  const match = /^\s*([^\s，。:：]{1,24})\s*(?:是)?\s*(?:由|取决于|受)/.exec(text);
  return match ? match[1]! : null;
}

/** `又称 投入产出比` / `别名：A、B` inside a description. */
function aliasesFromText(text: string): string[] {
  const found: string[] = [];
  const patterns = [/[（(](?:又称|也叫|也称|又名|别名|俗称|简称)\s*[:：]?\s*([^）)]+)[）)]/g, /(?:又称|也叫|也称|又名|别名|俗称|简称)\s*[:：]?\s*([^\s，。；;、]+)/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      found.push(...parseAliases(match[1]!));
    }
  }
  return unique(found);
}

function parseAliases(text: string): string[] {
  return unique(
    text
      .split(/[、，,／/;；]/)
      .map((part) => part.replace(ALIAS_PREFIX, '').replace(/[（）()\s]/g, '').trim())
      .filter((part) => part.length > 0 && part.length < 24),
  );
}

function looksLikeExpression(value: string): boolean {
  return /[A-Za-z_\u4e00-\u9fff]/.test(value) && !/^(?:是|为|指)/.test(value);
}

function stripBackticks(text: string): string {
  return text.replace(/`/g, '').trim();
}

/** `ＧＭＶ` / `GMV ` / `gmv` -> `GMV`, so an inline formula can be matched to the term it belongs to. */
function normalizeInline(name: string): string {
  return name.replace(/[\s*]/g, '').toUpperCase();
}

function splitLines(text: string): { text: string; start: number; end: number }[] {
  const lines: { text: string; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ text: text.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  return lines;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** A document this build cannot read. Reported as a gap, never silently skipped. */
export interface UnsupportedDocument {
  sourceFile: string;
  reason: string;
}

/**
 * PDF is a P1 gap with a name.
 *
 * Layout-aware PDF reading (columns, tables, the difference between a footnote and a definition) is a
 * project of its own; until it lands, a PDF in the fixture set is reported as an unread source in the
 * build notes, so coverage is under-reported rather than invented.
 */
export function readPdfPlaceholder(sourceFile: string): UnsupportedDocument {
  return { sourceFile, reason: 'PDF reading is not implemented in P1 (planned: layout-aware text + table extraction)' };
}
