/**
 * A tokenizer, and nothing else.
 *
 * It exists because both the DDL reader and the ETL-SQL reader need the same three things from SQL:
 * identifier boundaries, parenthesis depth, and exact character offsets so a candidate can cite the text
 * it came from. Anything cleverer (a real grammar, name resolution, a planner) belongs in the Python
 * `sqlkit` sidecar that P2 adds; this file is the part the extractors can rely on without it.
 */

export type TokenType = 'word' | 'quoted' | 'string' | 'number' | 'punct';

export interface Token {
  type: TokenType;
  /** The semantic value: an unquoted identifier, the string contents, the operator. */
  value: string;
  /** The exact source text, quotes included. */
  raw: string;
  /** Offsets into the whole input, half-open. */
  start: number;
  end: number;
  /** Parenthesis depth *before* this token (so `(` itself is at the outer depth). */
  depth: number;
}

const WORD = /[\p{L}\p{N}_$]/u;
const DIGIT = /[0-9]/;

/** Tokenizes one SQL text. Comments are dropped; their characters still count towards offsets. */
export function tokenize(sql: string, from = 0): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    // --- whitespace
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i++;
      continue;
    }
    // --- line comment
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    // --- block comment
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    // --- single-quoted string literal ('' escapes a quote)
    if (c === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: 'string', value: sql.slice(start + 1, i - 1), raw: sql.slice(start, i), start: from + start, end: from + i, depth });
      continue;
    }
    // --- quoted identifier: "x" | `x` | [x]
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      const start = i;
      i++;
      while (i < sql.length && sql[i] !== close) i++;
      const raw = sql.slice(start, i + 1);
      i++;
      tokens.push({ type: 'quoted', value: raw.slice(1, -1), raw, start: from + start, end: from + i, depth });
      continue;
    }
    // --- number
    if (DIGIT.test(c)) {
      const start = i;
      while (i < sql.length && (DIGIT.test(sql[i]!) || sql[i] === '.')) i++;
      const raw = sql.slice(start, i);
      tokens.push({ type: 'number', value: raw, raw, start: from + start, end: from + i, depth });
      continue;
    }
    // --- identifier / keyword
    if (WORD.test(c)) {
      const start = i;
      while (i < sql.length && WORD.test(sql[i]!)) i++;
      const raw = sql.slice(start, i);
      tokens.push({ type: 'word', value: raw, raw, start: from + start, end: from + i, depth });
      continue;
    }
    // --- punctuation / operator
    const start = i;
    if (c === '<' && sql[i + 1] === '=') i += 2;
    else if (c === '>' && sql[i + 1] === '=') i += 2;
    else if (c === '<' && sql[i + 1] === '>') i += 2;
    else if (c === '!' && sql[i + 1] === '=') i += 2;
    else if (c === ':' && sql[i + 1] === ':') i += 2;
    else i++;
    const raw = sql.slice(start, i);
    if (raw === ')') depth = Math.max(0, depth - 1);
    tokens.push({ type: 'punct', value: raw, raw, start: from + start, end: from + i, depth });
    if (raw === '(') depth++;
  }
  return tokens;
}

/** Splits statements on `;` that sit outside parentheses, quotes and comments. Offsets are preserved. */
export function splitStatements(sql: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      const close = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === close && close === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === close) break;
        i++;
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (c === ';') {
      const text = sql.slice(start, i);
      if (text.trim().length > 0) out.push({ text, start, end: i });
      start = i + 1;
    }
  }
  const tail = sql.slice(start);
  if (tail.trim().length > 0) out.push({ text: tail, start, end: sql.length });
  return out;
}

export const KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'all', 'distinct',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'as', 'and', 'or', 'not', 'in', 'is',
  'null', 'by', 'with', 'case', 'when', 'then', 'else', 'end', 'between', 'like', 'asc', 'desc', 'using',
  'natural', 'exists', 'interval', 'over', 'partition', 'window', 'cast', 'true', 'false',
]);

export function isKeyword(token: Token): boolean {
  return token.type === 'word' && KEYWORDS.has(token.value.toLowerCase());
}

/** True when the token can name a table, a column or an alias. */
export function isName(token: Token): boolean {
  return token.type === 'word' || token.type === 'quoted';
}

/** Splits a token list on a keyword or punctuation at depth 0, returning token slices. */
export function splitTokens(tokens: Token[], atDepth: number, isSeparator: (t: Token) => boolean): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.depth === atDepth && isSeparator(token)) {
      if (current.length > 0) parts.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}
