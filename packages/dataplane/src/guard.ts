/**
 * The one door to the warehouse, and the rules it enforces.
 *
 * A data agent that can be talked into writing is not a data agent, it is an incident. So a statement is
 * admitted only if it is a read: `SELECT`, `WITH ... SELECT`, `EXPLAIN`, `VALUES`. One statement per call,
 * no `PRAGMA`, no `ATTACH`, no bare `CREATE TABLE` (a CTAS is a write pretending to be a query).
 *
 * The check is deliberately conservative and textual-but-tokenized: it parses the statement into tokens
 * (so `'drop table'` inside a string literal is not a hit) and then refuses on the first token that could
 * change state. Being wrong in the safe direction - refusing a read we could have run - is the trade.
 */

import { tokenize, type Token } from '../../sqlkit-ts/src/tokenize.ts';

export class ReadOnlyViolation extends Error {
  readonly sql: string;
  constructor(message: string, sql: string) {
    super(message);
    this.name = 'ReadOnlyViolation';
    this.sql = sql;
  }
}

const ALLOWED_START = new Set(['select', 'with', 'explain', 'values']);

/** Keywords that mean "this is not a read", wherever they appear at statement level. */
const FORBIDDEN = new Set([
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'replace', 'merge', 'grant',
  'revoke', 'attach', 'detach', 'pragma', 'vacuum', 'reindex', 'begin', 'commit', 'rollback', 'savepoint',
  'call', 'copy', 'load', 'import', 'export', 'comment', 'set', 'kill', 'shutdown', 'into',
]);

export interface GuardResult {
  sql: string;
  statements: number;
  startKeyword: string;
}

/** Throws a {@link ReadOnlyViolation} unless `sql` is exactly one read-only statement. */
export function assertReadOnly(sql: string): GuardResult {
  const text = sql.trim();
  if (text.length === 0) throw new ReadOnlyViolation('empty statement', sql);

  const statements = splitTopLevel(text);
  if (statements.length > 1) {
    throw new ReadOnlyViolation(`expected one statement, got ${statements.length}`, sql);
  }

  const tokens = tokenize(text);
  const words = tokens.filter((t): t is Token => t.type === 'word');
  if (words.length === 0) throw new ReadOnlyViolation('statement has no keyword', sql);
  const start = words[0]!.value.toLowerCase();
  if (!ALLOWED_START.has(start)) {
    throw new ReadOnlyViolation(`'${start}' is not a read; only SELECT, WITH, EXPLAIN and VALUES run here`, sql);
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!.value.toLowerCase();
    if (!FORBIDDEN.has(word)) continue;
    // `into` is only dangerous in `SELECT ... INTO`, which is exactly where it appears; `set` is a keyword in
    // `UPDATE ... SET` (already refused) and an identifier in `SELECT set_col`. So check the neighbourhood.
    if (word === 'set' || word === 'into') {
      const prev = words[i - 1]?.value.toLowerCase();
      const next = words[i + 1]?.value.toLowerCase();
      const dangerous = word === 'into' || (word === 'set' && (prev === 'update' || next === undefined));
      if (!dangerous) continue;
    }
    throw new ReadOnlyViolation(`'${word}' is not allowed in a read-only statement`, sql);
  }

  return { sql: text, statements: 1, startKeyword: start };
}

/** Splits on `;` outside strings and comments, without re-implementing the tokenizer's offsets. */
function splitTopLevel(sql: string): string[] {
  const parts: string[] = [];
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
      if (sql.slice(start, i).trim().length > 0) parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  if (sql.slice(start).trim().length > 0) parts.push(sql.slice(start));
  return parts;
}
