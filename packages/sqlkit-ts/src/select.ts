/**
 * Reads a report/ETL `SELECT` far enough to say what it measures and what it reads.
 *
 * This is not a SQL parser and does not try to be one. It answers four questions that the semantic-layer
 * extractor actually asks of an existing query:
 *
 * 1. which physical tables does it read (lineage for `computedFrom`),
 * 2. which aggregated expressions does it project, under which alias (metric candidates),
 * 3. which columns do those expressions touch (lineage for `usesColumn`),
 * 4. which join equalities and `WHERE` conditions does it write (candidate `references`, and the 口径 a
 *    metric inherits: `status = 'paid'` is part of the definition, not a detail).
 *
 * CTEs and aliases are resolved one level deep. When a column cannot be resolved to a physical table the
 * analyzer says so in `unresolved` instead of inventing a table - a wrong lineage edge is worse than a
 * missing one, because the probe would validate the wrong join.
 */

import { tokenize, splitTokens, isKeyword, isName, type Token } from './tokenize.ts';

export type AggFunction = 'SUM' | 'COUNT' | 'COUNT_DISTINCT' | 'AVG' | 'MIN' | 'MAX';

export interface SelectProjection {
  /** The expression as emitted (identifiers table-qualified where they resolved). */
  expression: string;
  /** The expression exactly as written. */
  text: string;
  alias?: string;
  agg?: AggFunction;
  /** Resolved as `table.column`. */
  columns: string[];
  /** Identifiers that could not be resolved to one physical table. */
  unresolved: string[];
  span: [number, number];
}

export interface SelectAnalysis {
  /** The statement text. */
  sql: string;
  /** For `INSERT INTO tgt SELECT ...`: the table (and column list) the query writes. */
  target?: { table: string; columns: string[] };
  /** For `CREATE VIEW name AS SELECT ...`: the view's name. */
  view?: string;
  statementIndex: number;
  ctes: { name: string; tables: string[] }[];
  /** Physical tables in the order they appear. */
  tables: string[];
  /** Alias (and bare table name) -> physical table, or a CTE name that resolves further. */
  aliases: Record<string, string>;
  /** CTE name -> the physical tables its body reads. Empty for a non-CTE statement. */
  cteTables: Record<string, string[]>;
  joins: { left: string; right: string; text: string; unresolved: boolean }[];
  projections: SelectProjection[];
  groupBy: { text: string; column?: string; span?: [number, number] }[];
  filters: { text: string; column?: string; op?: string; value?: string }[];
  notes: string[];
}

const AGG_NAMES = new Set(['sum', 'count', 'avg', 'min', 'max']);

const SQL_FUNCTIONS = new Set([
  'sum', 'count', 'avg', 'min', 'max', 'coalesce', 'ifnull', 'nullif', 'cast', 'round', 'abs', 'floor',
  'ceil', 'ceiling', 'date', 'date_trunc', 'extract', 'year', 'month', 'day', 'substr', 'substring',
  'concat', 'length', 'lower', 'upper', 'trim', 'case', 'when', 'then', 'else', 'end', 'distinct',
  'filter', 'over', 'partition', 'row_number', 'rank', 'dense_rank', 'now', 'current_date', 'interval',
  'strftime', 'julianday', 'printf', 'greatest', 'least', 'nullif', 'isfinite',
]);

/** Analyzes every SELECT/WITH statement in a SQL text. */
export function analyzeSql(sql: string): SelectAnalysis[] {
  const analyses: SelectAnalysis[] = [];
  let index = 0;
  for (const statement of splitStatements(sql)) {
    // leading comments must not hide the statement: ask the tokens, not the raw text
    const tokens = tokenize(statement.text);
    const words = tokens.filter((token) => token.type === 'word');
    const firstWord = words[0]?.value.toLowerCase();
    if (firstWord !== 'select' && firstWord !== 'with' && firstWord !== 'insert' && firstWord !== 'create') continue;

    const shaped = shapeStatement(tokens, statement.text);
    if (!shaped) continue;
    const analysis = analyzeSelect(statement.text.slice(shaped.offset), statement.start + shaped.offset, index++);
    if (!analysis) continue;
    if (shaped.target) analysis.target = shaped.target;
    if (shaped.view) analysis.view = shaped.view;
    analyses.push(analysis);
  }
  return analyses;
}

/**
 * The part of a statement that is a SELECT, plus what the statement does around it.
 *
 * Three shapes matter to a semantic layer and all three appear in a real warehouse: a report (`SELECT`), a
 * view (`CREATE VIEW ... AS SELECT`, the口径 somebody already agreed on), and a load (`INSERT INTO tgt SELECT`,
 * the direction lineage actually flows). The wrapper is read here so `analyzeSelect` keeps taking a plain
 * SELECT and nothing downstream has to know how the statement was framed.
 */
function shapeStatement(tokens: Token[], text: string): { offset: number; target?: { table: string; columns: string[] }; view?: string } | null {
  const first = tokens.find((token) => token.type === 'word')?.value.toLowerCase();
  if (first === 'select' || first === 'with') return { offset: 0 };

  if (first === 'insert') {
    const into = tokens.findIndex((token) => token.type === 'word' && token.value.toLowerCase() === 'into');
    const table = tokens[into + 1]?.value;
    if (into < 0 || !table) return null;
    const columns: string[] = [];
    if (tokens[into + 2]?.value === '(') {
      for (let i = into + 3; i < tokens.length && tokens[i]!.value !== ')'; i++) {
        const token = tokens[i]!;
        if (token.type === 'word' || token.type === 'quoted') columns.push(token.value);
      }
    }
    const selectIndex = tokens.findIndex((token, i) => i > into
      && token.depth === 0 && token.type === 'word'
      && (token.value.toLowerCase() === 'select' || token.value.toLowerCase() === 'with'));
    if (selectIndex < 0) return null;
    return { offset: tokens[selectIndex]!.start, target: { table, columns } };
  }

  if (first === 'create') {
    const view = tokens.findIndex((token) => token.type === 'word' && token.value.toLowerCase() === 'view');
    if (view < 0) return null;
    const nameToken = tokens[view + 1];
    if (!nameToken) return null;
    const asIndex = tokens.findIndex((token, i) => i > view && token.type === 'word' && token.value.toLowerCase() === 'as');
    if (asIndex < 0) return null;
    return { offset: tokens[asIndex + 1]?.start ?? text.length, view: nameToken.value };
  }

  return null;
}

/** Analyzes one statement. `base` shifts every span into the file's coordinates. */
export function analyzeSelect(text: string, base: number, statementIndex: number): SelectAnalysis | null {
  const tokens = tokenize(text);
  const notes: string[] = [];
  const analysis: SelectAnalysis = {
    sql: text.trim(),
    statementIndex,
    ctes: [],
    tables: [],
    aliases: {},
    cteTables: {},
    joins: [],
    projections: [],
    groupBy: [],
    filters: [],
    notes,
  };

  let main = tokens;
  // --- WITH: each CTE is analyzed, and contributes its tables to the statement's lineage
  if (tokens[0]?.type === 'word' && tokens[0]!.value.toLowerCase() === 'with') {
    let i = 1;
    if (tokens[i]?.value.toLowerCase() === 'recursive') i++;
    for (;;) {
      const nameToken = tokens[i];
      if (!nameToken || !isName(nameToken)) break;
      const asToken = tokens[i + 1];
      if (!asToken || asToken.value.toLowerCase() !== 'as') break;
      const open = tokens[i + 2];
      if (!open || open.value !== '(') break;
      const close = matchingParen(tokens, i + 2);
      if (close < 0) break;
      const innerStart = open.end;
      const innerEnd = tokens[close]!.start;
      const inner = analyzeSelect(text.slice(innerStart, innerEnd), base + innerStart, statementIndex);
      if (inner) {
        analysis.ctes.push({ name: nameToken.value, tables: inner.tables });
        analysis.cteTables[nameToken.value] = inner.tables;
        for (const table of inner.tables) if (!analysis.tables.includes(table)) analysis.tables.push(table);
      }
      i = close + 1;
      if (tokens[i]?.value === ',') {
        i++;
        continue;
      }
      break;
    }
    main = tokens.slice(i);
  }

  const keywordsAt = (depth: number) =>
    main.map((t, idx) => ({ t, idx })).filter(({ t }) => t.depth === depth && t.type === 'word');

  const at0 = keywordsAt(0);
  const selectWord = at0.find(({ t }) => t.value.toLowerCase() === 'select');
  if (!selectWord) {
    notes.push('statement has no top-level SELECT');
    return null;
  }
  const fromWord = at0.find(({ t, idx }) => idx > selectWord.idx && t.value.toLowerCase() === 'from');
  const stopWords = new Set(['where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'window']);
  const selectEnd = fromWord ? fromWord.idx : main.length;
  const endWord = at0.find(({ t, idx }) => (fromWord ? idx > fromWord.idx : true) && stopWords.has(t.value.toLowerCase()));

  // --- FROM: tables, aliases, joins
  const fromTokens = fromWord ? main.slice(fromWord.idx + 1, endWord ? endWord.idx : main.length) : [];
  readFrom(fromTokens, text, base, analysis);
  for (const table of analysis.tables) if (!(table in analysis.aliases)) analysis.aliases[table] = table;

  // --- projections
  let projectionTokens = main.slice(selectWord.idx + 1, selectEnd);
  if (projectionTokens[0]?.value.toLowerCase() === 'distinct') projectionTokens = projectionTokens.slice(1);
  for (const part of splitTokens(projectionTokens, 0, (t) => t.value === ',')) {
    const projection = readProjection(part, text, base, analysis);
    if (projection) analysis.projections.push(projection);
  }

  // --- WHERE
  const whereWord = at0.find(({ t }) => t.value.toLowerCase() === 'where');
  if (whereWord) {
    const whereEnd = at0.find(({ t, idx }) => idx > whereWord.idx && stopWords.has(t.value.toLowerCase()) && t.value.toLowerCase() !== 'where');
    const whereTokens = main.slice(whereWord.idx + 1, whereEnd ? whereEnd.idx : main.length);
    for (const part of splitTokens(whereTokens, 0, (t) => t.value.toLowerCase() === 'and' || t.value.toLowerCase() === 'or')) {
      const filter = readFilter(part, text, base, analysis);
      if (filter) analysis.filters.push(filter);
    }
  }

  // --- GROUP BY
  const groupWord = at0.find(({ t }) => t.value.toLowerCase() === 'group');
  if (groupWord) {
    const byWord = at0.find(({ t, idx }) => idx > groupWord.idx && t.value.toLowerCase() === 'by');
    if (byWord) {
      const groupEnd = at0.find(({ t, idx }) => idx > byWord.idx && stopWords.has(t.value.toLowerCase()));
      const groupTokens = main.slice(byWord.idx + 1, groupEnd ? groupEnd.idx : main.length);
      for (const part of splitTokens(groupTokens, 0, (t) => t.value === ',')) {
        const item = readGroupBy(part, text, base, analysis);
        if (item) analysis.groupBy.push(item);
      }
    }
  }

  return analysis;
}

/** Reads the FROM clause: entries, aliases, join equalities. */
function readFrom(tokens: Token[], text: string, base: number, analysis: SelectAnalysis): void {
  if (tokens.length === 0) return;
  let i = 0;
  let pendingJoinText = '';
  while (i < tokens.length) {
    const token = tokens[i]!;
    const word = token.type === 'word' ? token.value.toLowerCase() : '';

    if (word === 'join' || word === 'from' || word === ',') {
      i++;
      continue;
    }
    if (['left', 'right', 'inner', 'outer', 'full', 'cross', 'natural'].includes(word)) {
      i++;
      continue;
    }
    if (word === 'on' || word === 'using') {
      const start = i + 1;
      let end = start;
      while (end < tokens.length) {
        const next = tokens[end]!;
        const nextWord = next.type === 'word' ? next.value.toLowerCase() : next.value;
        if (next.depth === 0 && (nextWord === 'join' || nextWord === ',' || ['left', 'right', 'inner', 'outer', 'full', 'cross'].includes(nextWord))) break;
        end++;
      }
      const conditionTokens = tokens.slice(start, end);
      if (word === 'on') readJoinCondition(conditionTokens, text, base, analysis, pendingJoinText);
      i = end;
      continue;
    }
    if (token.value === '(') {
      // a derived table: analyze it, and remember that this alias has no single physical table
      const close = matchingParen(tokens, i);
      if (close < 0) return;
      const innerStart = token.end;
      const innerEnd = tokens[close]!.start;
      const inner = analyzeSelect(text.slice(innerStart, innerEnd), base + innerStart, analysis.statementIndex);
      if (inner) {
        for (const table of inner.tables) if (!analysis.tables.includes(table)) analysis.tables.push(table);
        analysis.notes.push(`derived table at depth ${token.depth} reads ${inner.tables.join(', ') || 'nothing'}`);
      }
      i = close + 1;
      // optional alias after the derived table
      if (tokens[i] && isName(tokens[i]!) && !isKeyword(tokens[i]!)) {
        analysis.notes.push(`derived table alias '${tokens[i]!.value}' is not resolved to one table`);
        i++;
      }
      continue;
    }
    if (isName(token) && !isKeyword(token)) {
      let name = token.value;
      let j = i + 1;
      while (tokens[j]?.value === '.' && tokens[j + 1]) {
        name = tokens[j + 1]!.value;
        j += 2;
      }
      let alias: string | undefined;
      if (tokens[j]?.type === 'word' && tokens[j]!.value.toLowerCase() === 'as' && isName(tokens[j + 1]!)) {
        alias = tokens[j + 1]!.value;
        j += 2;
      } else if (tokens[j] && isName(tokens[j]!) && !isKeyword(tokens[j]!) && tokens[j]!.value !== '(') {
        alias = tokens[j]!.value;
        j++;
      }
      if (!analysis.tables.includes(name) && !(name in analysis.cteTables)) analysis.tables.push(name);
      analysis.aliases[name] = name;
      if (alias) analysis.aliases[alias] = name;
      pendingJoinText = text.slice(token.start, tokens[j - 1]?.end ?? token.end);
      i = j;
      continue;
    }
    i++;
  }
}

function readJoinCondition(tokens: Token[], text: string, base: number, analysis: SelectAnalysis, joinText: string): void {
  if (tokens.length === 0) return;
  for (const part of splitTokens(tokens, 0, (t) => t.value.toLowerCase() === 'and')) {
    const equals = part.findIndex((t) => t.depth === part[0]!.depth && t.value === '=');
    if (equals <= 0) continue;
    const leftTokens = part.slice(0, equals);
    const rightTokens = part.slice(equals + 1);
    const left = resolveOperand(leftTokens, analysis);
    const right = resolveOperand(rightTokens, analysis);
    if (!left || !right) continue;
    analysis.joins.push({
      left,
      right,
      text: text.slice(part[0]!.start, part[part.length - 1]!.end),
      unresolved: !left.includes('.') || !right.includes('.'),
    });
  }
  if (tokens.length > 0 && joinText) analysis.notes.push(`join '${joinText}'`);
}
/**
 * The physical table a qualifier stands for.
 *
 * A qualifier names a table, an alias, or a CTE. A CTE resolves only when its body reads exactly one
 * physical table - otherwise the column's lineage is genuinely ambiguous and is reported as unresolved
 * rather than attached to an arbitrary table.
 */
function resolveQualifier(qualifier: string, analysis: SelectAnalysis): string | undefined {
  const direct = analysis.aliases[qualifier];
  if (direct && direct in analysis.cteTables) {
    const tables = analysis.cteTables[direct]!;
    return tables.length === 1 ? tables[0] : undefined;
  }
  if (direct) return direct;
  const cte = analysis.cteTables[qualifier];
  return cte && cte.length === 1 ? cte[0] : undefined;
}

/** Turns `a.col` / `col` into `table.col` when the qualifier resolves to one physical table. */
function resolveOperand(tokens: Token[], analysis: SelectAnalysis): string | undefined {
  const names = tokens.filter((t) => t.type === 'word' || t.type === 'quoted');
  if (names.length === 0) return undefined;
  if (names.length >= 2) {
    const qualifier = names[0]!.value;
    const column = names[1]!.value;
    const table = resolveQualifier(qualifier, analysis);
    return table ? `${table}.${column}` : `${qualifier}.${column}`;
  }
  return names[0]!.value;
}

function readProjection(part: Token[], text: string, base: number, analysis: SelectAnalysis): SelectProjection | null {
  if (part.length === 0) return null;
  const first = part[0]!;
  const last = part[part.length - 1]!;

  // --- trailing alias: `AS x`, or a bare name that closes an expression (`SUM(x) total`, `a.b revenue`)
  let alias: string | undefined;
  let endIndex = part.length;
  const before = part[part.length - 2];
  if (before && before.type === 'word' && before.value.toLowerCase() === 'as' && isName(last)) {
    alias = last.value;
    endIndex = part.length - 2;
  } else if (part.length >= 2 && isName(last) && !isKeyword(last) && before) {
    const closesExpression =
      before.value === ')' || before.type === 'string' || before.type === 'number' ||
      (part.length === 2 && isName(before) && before.value !== '.');
    if (closesExpression) {
      alias = last.value;
      endIndex = part.length - 1;
    }
  }

  const exprTokens = part.slice(0, endIndex);
  if (exprTokens.length === 0) return null;
  const exprStart = exprTokens[0]!.start;
  const exprEnd = exprTokens[exprTokens.length - 1]!.end;

  const agg = readAggregate(exprTokens);
  const { rendered, columns, unresolved } = qualify(exprTokens, analysis);
  return {
    expression: rendered,
    text: text.slice(exprStart, exprEnd),
    alias,
    agg,
    columns,
    unresolved,
    span: [base + first.start, base + last.end],
  };
}

function readAggregate(tokens: Token[]): AggFunction | undefined {
  const first = tokens[0];
  if (!first || first.type !== 'word') return undefined;
  const name = first.value.toLowerCase();
  if (!AGG_NAMES.has(name)) return undefined;
  if (tokens[1]?.value !== '(') return undefined;
  if (tokens[2]?.value.toLowerCase() === 'distinct') {
    return name === 'count' ? 'COUNT_DISTINCT' : (name.toUpperCase() as AggFunction);
  }
  return name.toUpperCase() as AggFunction;
}

/**
 * Rewrites an expression's identifiers as `table.column` where they resolve, and reports what did not.
 *
 * Rendering rather than string replacement: the tokens are what the SQL means, so replacing the token and
 * keeping everything else is the only rewrite that cannot accidentally hit a literal.
 */
function qualify(tokens: Token[], analysis: SelectAnalysis): { rendered: string; columns: string[]; unresolved: string[] } {
  const columns: string[] = [];
  const unresolved: string[] = [];
  const pieces: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const isNameToken = (token.type === 'word' || token.type === 'quoted') && !isKeyword(token);
    if (!isNameToken) {
      pieces.push(token.raw);
      continue;
    }
    const next = tokens[i + 1];
    const lower = token.value.toLowerCase();
    if (next?.value === '(' && token.type === 'word') {
      // a function call, not a column
      pieces.push(token.raw);
      continue;
    }
    if (token.type === 'word' && SQL_FUNCTIONS.has(lower)) {
      pieces.push(token.raw);
      continue;
    }
    // qualified: a.b or a.b.c
    if (next?.value === '.' && tokens[i + 1]) {
      const parts: string[] = [token.value];
      let j = i + 1;
      while (tokens[j]?.value === '.' && tokens[j + 1]) {
        parts.push(tokens[j + 1]!.value);
        j += 2;
      }
      const qualifier = parts.length === 2 ? parts[0]! : parts[parts.length - 2]!;
      const column = parts[parts.length - 1]!;
      const table = resolveQualifier(qualifier, analysis);
      if (table) {
        columns.push(`${table}.${column}`);
        pieces.push(`${table}.${column}`);
      } else {
        unresolved.push(parts.join('.'));
        pieces.push(parts.join('.'));
      }
      i = j - 1;
      continue;
    }
    // bare identifier: only meaningful as a column when the statement reads exactly one table
    if (analysis.tables.length === 1) {
      columns.push(`${analysis.tables[0]}.${token.value}`);
      pieces.push(`${analysis.tables[0]}.${token.value}`);
    } else {
      unresolved.push(token.value);
      pieces.push(token.raw);
    }
  }
  return { rendered: joinSql(pieces), columns, unresolved };
}

/** Joins rebuilt fragments so the result parses: no space around `.`, `(` and `)`, spaces elsewhere. */
function joinSql(pieces: string[]): string {
  let out = '';
  for (const piece of pieces) {
    const tightBefore = piece === ')' || piece === ',' || piece === '.' || piece === '(' || piece === '::';
    const tightAfter = out.endsWith('(') || out.endsWith('.') || out.endsWith('::');
    if (out.length > 0 && !tightBefore && !tightAfter) out += ' ';
    out += piece;
    if (piece === ',') out += ' ';
  }
  return out.trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ');
}

function readFilter(part: Token[], text: string, base: number, analysis: SelectAnalysis): { text: string; column?: string; op?: string; value?: string } | null {
  if (part.length === 0) return null;
  const whole = text.slice(part[0]!.start, part[part.length - 1]!.end);
  const operators = ['>=', '<=', '<>', '!=', '=', '>', '<'];
  for (let i = 0; i < part.length; i++) {
    const token = part[i]!;
    if (token.type === 'punct' && operators.includes(token.value)) {
      const left = resolveOperand(part.slice(0, i), analysis);
      const right = part.slice(i + 1).map((t) => t.raw).join(' ');
      return { text: whole, column: left, op: token.value, value: right.trim() };
    }
  }
  const lower = part.map((t) => t.value.toLowerCase());
  for (const keyword of ['like', 'in', 'between', 'is']) {
    const at = lower.indexOf(keyword);
    if (at > 0) {
      return {
        text: whole,
        column: resolveOperand(part.slice(0, at), analysis),
        op: keyword,
        value: part.slice(at + 1).map((t) => t.raw).join(' ').trim(),
      };
    }
  }
  return { text: whole };
}

function readGroupBy(part: Token[], text: string, base: number, analysis: SelectAnalysis): { text: string; column?: string; span?: [number, number] } | null {
  if (part.length === 0) return null;
  // a function call (`substr(o.order_date, 1, 7)`) is an expression, not a column: resolving its first token
  // would produce the nonsense `substr.o`
  const column = part[1]?.value === '(' ? undefined : resolveOperand(part, analysis);
  return {
    text: text.slice(part[0]!.start, part[part.length - 1]!.end),
    column,
    span: [base + part[0]!.start, base + part[part.length - 1]!.end],
  };
}

function matchingParen(tokens: Token[], openIndex: number): number {
  const open = tokens[openIndex]!;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    if (tokens[i]!.value === ')' && tokens[i]!.depth === open.depth) return i;
  }
  return -1;
}

function splitStatements(sql: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
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
      if (sql.slice(start, i).trim().length > 0) out.push({ text: sql.slice(start, i), start });
      start = i + 1;
    }
  }
  if (sql.slice(start).trim().length > 0) out.push({ text: sql.slice(start), start });
  return out;
}
