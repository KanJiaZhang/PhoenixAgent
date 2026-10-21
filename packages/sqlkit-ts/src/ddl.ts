/**
 * Reads `CREATE TABLE` and keeps what the catalog cannot tell us.
 *
 * A live catalog answers "which columns exist and what type are they". It does not answer "what does this
 * column mean", and in MySQL it does not survive a schema dump losing its comments. So the DDL text is a
 * source in its own right: primary keys, foreign keys, column comments and table comments are read here,
 * with the character range of every claim, and the catalog is used later to disagree with it.
 *
 * The grammar accepted is the one warehouses actually emit: MySQL backticks, Postgres double quotes,
 * Hive/Doris brackets, `IF NOT EXISTS`, qualified names, table options after the closing paren, and
 * inline `COMMENT` on columns. Anything it does not understand is reported as a parse note rather than
 * dropped silently - a column that vanishes without a word is worse than a parse error.
 */

import { tokenize, splitTokens, type Token } from './tokenize.ts';

export interface DdlReference {
  table: string;
  column: string;
}

export interface DdlColumn {
  name: string;
  /** The type as written, whitespace collapsed: `DECIMAL(15,2)`, `VARCHAR(64)`, `DATETIME`. */
  dataType: string;
  /** The base type word, uppercased: `DECIMAL`, `VARCHAR`, `DATETIME`. */
  baseType: string;
  notNull: boolean;
  primaryKey: boolean;
  references?: DdlReference;
  comment?: string;
  span: [number, number];
}

export interface DdlIndex {
  name?: string;
  columns: string[];
}

export interface DdlTable {
  name: string;
  columns: DdlColumn[];
  primaryKey: string[];
  foreignKeys: { columns: string[]; refTable: string; refColumns: string[]; span?: [number, number] }[];
  indexes: DdlIndex[];
  comment?: string;
  span: [number, number];
}

export interface DdlParseResult {
  tables: DdlTable[];
  /** Statements that were not `CREATE TABLE`, and `CREATE TABLE`s this reader could not fully read. */
  notes: string[];
}

const CONSTRAINT_START = new Set([
  'primary', 'foreign', 'unique', 'key', 'index', 'constraint', 'check', 'fulltext', 'spatial',
]);

/** Keywords that end a column's type and start its constraints. */
const CONSTRAINT_WORDS = new Set([
  'not', 'null', 'default', 'primary', 'unique', 'references', 'comment', 'check', 'auto_increment',
  'autoincrement', 'generated', 'collate', 'constraint', 'on', 'unsigned', 'zerofill', 'identity',
]);

export function parseDdl(sql: string): DdlParseResult {
  const tables: DdlTable[] = [];
  const notes: string[] = [];

  for (const statement of splitStatementsIn(sql)) {
    const tokens = tokenize(statement.text);
    const firstWords = tokens.filter((t) => t.type === 'word').slice(0, 4).map((t) => t.value.toLowerCase());
    if (firstWords[0] !== 'create' || firstWords[1] !== 'table') {
      // views and indexes are read elsewhere (the SQL reader and the catalog); only report what nothing owns
      const owner = firstWords[1];
      if (tokens.length > 0 && firstWords[0] === 'create' && owner !== 'view' && owner !== 'index'
        && owner !== 'unique' && owner !== 'database' && owner !== 'schema' && owner !== 'or') {
        notes.push(`skipped non-table statement '${firstWords[0]} ${owner ?? ''}' at offset ${statement.start}`);
      }
      continue;
    }
    const parsed = parseCreateTable(tokens, statement.text, statement.start);
    if (typeof parsed === 'string') notes.push(parsed);
    else tables.push(parsed);
  }
  return { tables, notes };
}

function splitStatementsIn(sql: string): { text: string; start: number }[] {
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

function parseCreateTable(tokens: Token[], text: string, base: number): DdlTable | string {
  let i = 2;
  if (wordAt(tokens, i) === 'if' && wordAt(tokens, i + 1) === 'not' && wordAt(tokens, i + 2) === 'exists') i += 3;
  const nameToken = tokens[i];
  if (!nameToken) return 'CREATE TABLE without a name';
  let name = nameToken.value;
  // a qualified name keeps its last part: db.tbl -> tbl
  while (tokens[i + 1]?.value === '.' && tokens[i + 2]) {
    name = tokens[i + 2]!.value;
    i += 2;
  }
  i++;
  const open = tokens[i];
  if (!open || open.value !== '(') return `CREATE TABLE ${name}: expected '(' but found '${open?.value ?? 'end'}'`;
  const openDepth = open.depth;
  const inner = openDepth + 1;
  let close = -1;
  for (let k = i + 1; k < tokens.length; k++) {
    const token = tokens[k]!;
    if (token.value === ')' && token.depth === openDepth) {
      close = k;
      break;
    }
  }
  if (close < 0) return `CREATE TABLE ${name}: unbalanced parentheses`;

  const body = tokens.slice(i + 1, close);
  const parts = splitTokens(body, inner, (t) => t.value === ',');
  const table: DdlTable = {
    name,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
    span: [base + nameToken.start, base + tokens[close]!.end],
  };

  for (const part of parts) {
    if (part.length === 0) continue;
    const head = part[0]!;
    const headWord = head.type === 'word' ? head.value.toLowerCase() : '';
    if (CONSTRAINT_START.has(headWord)) {
      readTableConstraint(part, table, text, base);
      continue;
    }
    const column = readColumn(part, text, base);
    if (typeof column === 'string') return `CREATE TABLE ${name}: ${column}`;
    table.columns.push(column);
    if (column.primaryKey) table.primaryKey.push(column.name);
    if (column.references) {
      table.foreignKeys.push({
        columns: [column.name],
        refTable: column.references.table,
        refColumns: [column.references.column],
        span: column.span,
      });
    }
  }

  // table COMMENT '...' lives after the closing paren
  for (let k = close + 1; k < tokens.length - 1; k++) {
    if (tokens[k]!.type === 'word' && tokens[k]!.value.toLowerCase() === 'comment' && tokens[k + 1]!.type === 'string') {
      table.comment = tokens[k + 1]!.value;
    }
  }
  return table;
}

function readColumn(part: Token[], text: string, base: number): DdlColumn | string {
  const nameToken = part[0]!;
  if (nameToken.type !== 'word' && nameToken.type !== 'quoted') return `column without a name near '${nameToken.raw}'`;
  const column: DdlColumn = {
    name: nameToken.value,
    dataType: '',
    baseType: '',
    notNull: false,
    primaryKey: false,
    span: [base + nameToken.start, base + part[part.length - 1]!.end],
  };

  // --- the type: everything until a constraint keyword, with balanced parentheses
  const typeTokens: Token[] = [];
  let k = 1;
  while (k < part.length) {
    const token = part[k]!;
    const word = token.type === 'word' ? token.value.toLowerCase() : '';
    if (token.value === '(') {
      // `DECIMAL(15,2)`: keep the group as written
      typeTokens.push(token);
      let depth = token.depth;
      k++;
      while (k < part.length) {
        const inner = part[k]!;
        typeTokens.push(inner);
        k++;
        if (inner.value === ')' && inner.depth === depth) break;
      }
      continue;
    }
    if (word !== '' && CONSTRAINT_WORDS.has(word) && typeTokens.length > 0) break;
    if (word === 'unsigned' || word === 'zerofill') {
      typeTokens.push(token);
      k++;
      continue;
    }
    if (typeTokens.length > 0 && word === '') {
      // a punctuation other than '(' ends the type (`;`, `=`)
      break;
    }
    typeTokens.push(token);
    k++;
  }
  column.dataType = collapse(text.slice(typeTokens[0]!.start, typeTokens[typeTokens.length - 1]!.end));
  column.baseType = (typeTokens.find((t) => t.type === 'word')?.value ?? '').toUpperCase();
  if (column.dataType === '') return `column ${column.name}: no type`;

  // --- the constraints
  for (let j = k; j < part.length; j++) {
    const token = part[j]!;
    const word = token.type === 'word' ? token.value.toLowerCase() : token.value;
    if (word === 'not' && wordAt(part, j + 1) === 'null') {
      column.notNull = true;
      j++;
      continue;
    }
    if (word === 'primary' && wordAt(part, j + 1) === 'key') {
      column.primaryKey = true;
      j++;
      continue;
    }
    if (word === 'references') {
      let p = j + 1;
      const tableToken = part[p];
      if (!tableToken) return `column ${column.name}: REFERENCES without a table`;
      let refTable = tableToken.value;
      p++;
      while (part[p]?.value === '.' && part[p + 1]) {
        refTable = part[p + 1]!.value;
        p += 2;
      }
      let refColumn = 'id';
      if (part[p]?.value === '(' && part[p + 1]) {
        refColumn = part[p + 1]!.value;
      }
      column.references = { table: refTable, column: refColumn };
      continue;
    }
    if (word === 'comment' && part[j + 1]?.type === 'string') {
      column.comment = part[j + 1]!.value;
      j++;
    }
  }
  return column;
}

function readTableConstraint(part: Token[], table: DdlTable, text: string, base: number): void {
  const words = part.map((t) => (t.type === 'word' ? t.value.toLowerCase() : t.value));
  const openAt = part.findIndex((t) => t.value === '(');
  const names = (from: number): string[] => {
    const out: string[] = [];
    let depth = part[from]!.depth;
    for (let k = from; k < part.length; k++) {
      const token = part[k]!;
      if (token.value === ')' && token.depth === depth) break;
      if (token.type === 'word' || token.type === 'quoted') {
        out.push(token.value);
      }
    }
    return out;
  };

  const primaryAt = words.indexOf('primary');
  if (primaryAt >= 0 && words[primaryAt + 1] === 'key') {
    const k = part.findIndex((t, idx) => idx > primaryAt && t.value === '(');
    if (k >= 0) {
      const cols = names(k);
      table.primaryKey.push(...cols);
      for (const column of table.columns) if (cols.includes(column.name)) column.primaryKey = true;
    }
    return;
  }

  const foreignAt = words.indexOf('foreign');
  if (foreignAt >= 0) {
    const open = part.findIndex((t, idx) => idx > foreignAt && t.value === '(');
    const refAt = words.indexOf('references');
    if (open >= 0 && refAt > open) {
      const cols = names(open);
      let refTable = part[refAt + 1]?.value ?? '';
      let p = refAt + 2;
      while (part[p]?.value === '.' && part[p + 1]) {
        refTable = part[p + 1]!.value;
        p += 2;
      }
      const refCols: string[] = [];
      if (part[p]?.value === '(') {
        for (let k = p + 1; k < part.length; k++) {
          const token = part[k]!;
          if (token.value === ')') break;
          if (token.type === 'word' || token.type === 'quoted') refCols.push(token.value);
        }
      }
      const span: [number, number] = [base + part[0]!.start, base + part[part.length - 1]!.end];
      table.foreignKeys.push({ columns: cols, refTable, refColumns: refCols.length > 0 ? refCols : ['id'], span });
    }
    return;
  }

  const keyAt = words.findIndex((w) => w === 'key' || w === 'index');
  if (openAt >= 0 && keyAt >= 0) {
    const name = part.slice(keyAt + 1, openAt).filter((t) => t.type === 'word' || t.type === 'quoted').at(-1)?.value;
    table.indexes.push({ name, columns: names(openAt) });
  }
}

function wordAt(tokens: Token[], index: number): string {
  const token = tokens[index];
  return token && token.type === 'word' ? token.value.toLowerCase() : '';
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
