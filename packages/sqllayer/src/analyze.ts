/**
 * M3, the shared SQL layer: what is wrong with a query, what to do about it, and the proof.
 *
 * Every sub-agent runs its SQL through this package, which is why the performance knowledge accumulates in
 * one place instead of five. It has three parts and one rule:
 *
 * - {@link analyze} finds the problems. It is *static*: tokens and the parse tree, no database. Fast, and it
 *   works on a query that cannot be run yet.
 * - {@link proposeRewrites} offers rewrites. Each one carries a rationale, and only rewrites that are
 *   result-preserving are marked `kind: 'rewrite'`; anything that changes the answer (adding a `LIMIT`,
 *   dropping a column somebody asked for) is a `suggestion` and is never applied silently.
 * - {@link explain} prices a query against the real database: SQLite's `EXPLAIN QUERY PLAN` says whether a
 *   table is scanned or searched through an index, and the wall time says whether the plan mattered.
 *
 * The rule: **a rewrite is a hypothesis until it is measured.** The claim "this is faster" is only made when
 * the plan or the timing changed, and when it did not, the finding says `no improvement` rather than leaving
 * a green tick. Static rules propose; evidence decides.
 */

import { DatabaseSync } from 'node:sqlite';
import { analyzeSql, tokenize, type SelectAnalysis } from '../../sqlkit-ts/src/index.ts';
import type { Catalog } from '../../dataplane/src/sqlite.ts';
import { assertReadOnly } from '../../dataplane/src/guard.ts';

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** The fragment of SQL the finding is about. */
  evidence: string;
  suggestion?: string;
}

export interface AnalyzeContext {
  catalog?: Catalog;
  /** The columns the caller actually needs; without it, P01 can only suggest, not rewrite. */
  requiredColumns?: string[];
  /** Below this row count a scan is not worth reporting. */
  rowCountThreshold?: number;
}

export interface RewriteStep {
  seq: number;
  rule: string;
  /** `rewrite` is result-preserving and may be applied; `suggestion` changes what the query returns. */
  kind: 'rewrite' | 'suggestion';
  sqlBefore: string;
  sqlAfter: string;
  rationale: string;
}

export interface ExplainEvidence {
  sql: string;
  /** The raw `EXPLAIN QUERY PLAN` details, one per line. */
  plan: string[];
  fullScans: string[];
  indexSearches: { table: string; index?: string; detail: string }[];
  rows: number;
  durationMs: number;
}

const DEFAULT_ROW_THRESHOLD = 5_000;

// --- analysis ----------------------------------------------------------------------------------------

export function analyze(sql: string, context: AnalyzeContext = {}): Finding[] {
  const findings: Finding[] = [];
  const statements = analyzeSql(sql);
  if (statements.length === 0) {
    return [{ rule: 'P00', severity: 'high', message: 'no SELECT statement was found', evidence: sql.slice(0, 60) }];
  }

  for (const statement of statements) {
    findings.push(...projectionFindings(statement, context));
    findings.push(...dateFilterFindings(statement, context));
    findings.push(...nonSargableFindings(statement));
    findings.push(...orFindings(statement));
    findings.push(...joinFindings(statement));
    findings.push(...limitFindings(statement));
  }
  return findings;
}

/** P01: `SELECT *` (or more columns than the caller needs) reads columns nobody uses. */
function projectionFindings(statement: SelectAnalysis, context: AnalyzeContext): Finding[] {
  const star = statement.projections.find((projection) => projection.expression.trim() === '*');
  if (star) {
    const table = statement.tables[0];
    const columns = table
      ? context.catalog?.tables.find((entry) => entry.name === table)?.columns.map((column) => column.name) ?? []
      : [];
    return [{
      rule: 'P01',
      severity: 'medium',
      message: `SELECT * reads every column of ${statement.tables.join(', ') || 'the source'}`
        + (columns.length > 0 ? ` (${columns.length} columns)` : ''),
      evidence: star.text,
      suggestion: columns.length > 0
        ? `list only the columns the caller needs: ${columns.slice(0, 6).join(', ')}${columns.length > 6 ? ', ...' : ''}`
        : 'list only the columns the caller needs',
    }];
  }

  const required = context.requiredColumns;
  if (required && required.length > 0) {
    const projected = new Set(statement.projections.map((projection) => projection.alias ?? projection.expression));
    const extra = [...projected].filter((name) => !required.includes(name));
    if (extra.length > 0) {
      return [{
        rule: 'P01',
        severity: 'low',
        message: `${extra.length} projected column(s) are not used by the caller: ${extra.join(', ')}`,
        evidence: extra.join(', '),
        suggestion: `project only ${required.join(', ')}`,
      }];
    }
  }
  return [];
}

/** P02: a fact table with a date column, filtered on nothing. */
function dateFilterFindings(statement: SelectAnalysis, context: AnalyzeContext): Finding[] {
  if (!context.catalog) return [];
  const threshold = context.rowCountThreshold ?? DEFAULT_ROW_THRESHOLD;
  const findings: Finding[] = [];
  const filtered = new Set(statement.filters.map((filter) => filter.column).filter(Boolean));

  for (const table of statement.tables) {
    const meta = context.catalog.tables.find((entry) => entry.name === table);
    if (!meta) continue;
    const dateColumn = meta.columns.find((column) => /DATE|TIMESTAMP/i.test(column.dataType));
    if (!dateColumn) continue;
    if (filtered.has(`${table}.${dateColumn.name}`)) continue;
    // small tables are not worth a finding: the threshold is what makes this rule usable in a demo and in
    // a warehouse alike
    if (meta.rowCount < threshold) continue;
    findings.push({
      rule: 'P02',
      severity: 'medium',
      message: `${table} has ${meta.rowCount} rows and its date column ${dateColumn.name} is not filtered`,
      evidence: `FROM ${table}`,
      suggestion: `add a range predicate on ${table}.${dateColumn.name}; a partition-pruned scan beats a full one`,
    });
  }
  return findings;
}

/** P03: a predicate wrapped in a function cannot use the index on the column inside it. */
function nonSargableFindings(statement: SelectAnalysis): Finding[] {
  const findings: Finding[] = [];
  for (const filter of statement.filters) {
    if (/^\s*(substr|strftime|date|date_trunc|cast|year|month|day|upper|lower)\s*\(/i.test(filter.text)) {
      findings.push({
        rule: 'P03',
        severity: 'high',
        message: `the predicate wraps the column in a function, so no index on it can be used`,
        evidence: filter.text,
        suggestion: 'rewrite it as a range on the raw column (a date prefix becomes [start, next))',
      });
    }
  }
  return findings;
}

/** P04: an OR across different columns usually prevents an index from being chosen at all. */
function orFindings(statement: SelectAnalysis): Finding[] {
  // the parser splits predicates on AND/OR, so the disjunction has to be read from the clause itself
  const where = /\bwhere\b([\s\S]*?)(?:\bgroup\b|\border\b|\blimit\b|$)/i.exec(statement.sql)?.[1];
  if (!where || !/\s+or\s+/i.test(where)) return [];
  const sides = where.split(/\s+or\s+/i);
  const columns = new Set(sides
    .map((side) => /([\w]+)\.([\w]+)/.exec(side)?.[2] ?? /^\s*([A-Za-z_][\w]*)/.exec(side)?.[1])
    .filter((column): column is string => typeof column === 'string'));
  if (columns.size < 2) return [];
  return [{
    rule: 'P04',
    severity: 'medium',
    message: 'the WHERE clause ORs different columns; each side can use an index, the disjunction usually cannot',
    evidence: where.trim(),
    suggestion: 'split into two SELECTs joined by UNION ALL',
  }];
}

/** P06: more than one table, and no predicate that connects them. */
function joinFindings(statement: SelectAnalysis): Finding[] {
  if (statement.tables.length < 2) return [];
  const joined = statement.joins.some((join) => !join.unresolved)
    || statement.filters.some((filter) => /^\s*[\w]+\.([\w]+)\s*=\s*[\w]+\.\1\s*$/i.test(filter.text))
    || statement.filters.some((filter) => /^\s*[\w]+\.[\w]+\s*=\s*[\w]+\.[\w]+\s*$/i.test(filter.text));
  if (joined) return [];
  return [{
    rule: 'P06',
    severity: 'high',
    message: `${statement.tables.length} tables are read with nothing joining them: this is a cartesian product`,
    evidence: `FROM ${statement.tables.join(', ')}`,
    suggestion: 'add the ON predicate, or take the join path from the semantic model (references edges)',
  }];
}

/** P13: an unbounded row set with no aggregate. */
function limitFindings(statement: SelectAnalysis): Finding[] {
  if (/\blimit\b/i.test(statement.sql)) return [];
  const aggregates = statement.projections.some((projection) => projection.agg);
  if (aggregates || statement.groupBy.length > 0) return [];
  return [{
    rule: 'P13',
    severity: 'low',
    message: 'the query returns an unbounded row set',
    evidence: statement.sql.slice(0, 60),
    suggestion: 'add a LIMIT, or a keyset predicate for paging',
  }];
}

// --- rewrites ----------------------------------------------------------------------------------------

/**
 * The rewrites this build can prove. Two of them, both narrow on purpose:
 *
 * - **P01** with `requiredColumns`: replace `*`/the projection list with the columns the caller needs. Only
 *   when the FROM is one table, because "which columns exist" is only answerable per table here.
 * - **P03**: a month or year prefix on a date column becomes a half-open range. This is the rewrite that
 *   matters most in practice - `substr(order_date,1,7) = '2024-05'` scans, `order_date >= '2024-05-01' AND
 *   order_date < '2024-06-01'` searches - and `verify:m3` proves it on real rows before it is offered as a
 *   step.
 *
 * Everything else stays a `suggestion`: splitting an OR or adding a LIMIT changes what the query returns, and
 * a data agent that quietly changes the answer has stopped being one.
 */
export function proposeRewrites(sql: string, context: AnalyzeContext = {}): RewriteStep[] {
  const steps: RewriteStep[] = [];
  const statements = analyzeSql(sql);
  if (statements.length === 0) return steps;

  let current = sql;

  const required = context.requiredColumns;
  if (required && required.length > 0 && statements[0]!.tables.length === 1) {
    const table = statements[0]!.tables[0]!;
    const meta = context.catalog?.tables.find((entry) => entry.name === table);
    const usable = required.filter((column) => !meta || meta.columns.some((entry) => entry.name === column));
    if (usable.length > 0) {
      const star = /\bselect\s+\*/i.exec(current);
      const after = star
        ? current.replace(/\bselect\s+\*/i, `SELECT ${usable.join(', ')}`)
        : current;
      if (after !== current) {
        steps.push({
          seq: steps.length + 1,
          rule: 'P01',
          kind: 'rewrite',
          sqlBefore: current,
          sqlAfter: after,
          rationale: `the caller needs ${usable.length} column(s); projecting them instead of every column`,
        });
        current = after;
      }
    }
  }

  for (const statement of analyzeSql(current)[0]?.filters ?? []) {
    const rewrite = datePrefixRewrite(statement.text);
    if (!rewrite) continue;
    if (!current.includes(statement.text)) continue;
    const after = current.replace(statement.text, rewrite.replacement);
    steps.push({
      seq: steps.length + 1,
      rule: 'P03',
      kind: 'rewrite',
      sqlBefore: current,
      sqlAfter: after,
      rationale: rewrite.rationale,
    });
    current = after;
  }

  // an unbounded result is offered as a step too, but marked a suggestion: a LIMIT changes the answer, and
  // the workbench refuses to apply it without a person saying so
  const first = analyzeSql(current)[0];
  if (first && !/limit/i.test(current) && !first.projections.some((projection) => projection.agg)
    && first.groupBy.length === 0) {
    steps.push({
      seq: steps.length + 1,
      rule: 'P13',
      kind: 'suggestion',
      sqlBefore: current,
      sqlAfter: `${current.replace(/;s*$/, '')} LIMIT 1000`,
      rationale: 'the query returns an unbounded row set; a LIMIT is a decision about the answer, so it is a suggestion',
    });
  }

  return steps;
}

/** `substr(col,1,7) = '2024-05'` -> `col >= '2024-05-01' AND col < '2024-06-01'`. */
export function datePrefixRewrite(predicate: string): { replacement: string; rationale: string } | null {
  const month = /^\s*substr\s*\(\s*([\w.]+)\s*,\s*1\s*,\s*7\s*\)\s*=\s*'(\d{4})-(\d{2})'\s*$/i.exec(predicate);
  if (month) {
    const [, column, year, monthPart] = month;
    const monthNumber = Number(monthPart);
    if (monthNumber < 1 || monthNumber > 12) return null;
    const start = `${year}-${monthPart}-01`;
    const end = monthNumber === 12
      ? `${Number(year) + 1}-01-01`
      : `${year}-${String(monthNumber + 1).padStart(2, '0')}-01`;
    return {
      replacement: `${column} >= '${start}' AND ${column} < '${end}'`,
      rationale: `a month prefix is a half-open range on ${column}: [${start}, ${end}), which an index on the column can seek`,
    };
  }
  const year = /^\s*substr\s*\(\s*([\w.]+)\s*,\s*1\s*,\s*4\s*\)\s*=\s*'(\d{4})'\s*$/i.exec(predicate);
  if (year) {
    const [, column, value] = year;
    return {
      replacement: `${column} >= '${value}-01-01' AND ${column} < '${Number(value) + 1}-01-01'`,
      rationale: `a year prefix is a half-open range on ${column}: [${value}-01-01, ${Number(value) + 1}-01-01)`,
    };
  }
  return null;
}

// --- evidence ----------------------------------------------------------------------------------------

/** Runs the query plan and the query, and reports both. The plan is the claim; the time is the check. */
export function explain(db: DatabaseSync, sql: string, options: { rowLimit?: number } = {}): ExplainEvidence {
  assertReadOnly(sql);
  const planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail?: string; id?: number; parent?: number }[];
  const plan = planRows.map((row) => String(row.detail ?? '')).filter((detail) => detail.length > 0);

  const fullScans: string[] = [];
  const indexSearches: { table: string; index?: string; detail: string }[] = [];
  for (const detail of plan) {
    const search = /^SEARCH\s+(\S+)\s+USING\s+(?:COVERING\s+)?INDEX\s+(\S+)/i.exec(detail);
    if (search) {
      indexSearches.push({ table: search[1]!, index: search[2]!, detail });
      continue;
    }
    const scan = /^SCAN\s+(\S+)/i.exec(detail);
    if (scan) fullScans.push(scan[1]!);
  }

  const started = performance.now();
  const rows = db.prepare(sql).all({ }) as unknown[];
  const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
  const limit = options.rowLimit ?? 10_000;
  return {
    sql,
    plan,
    fullScans,
    indexSearches,
    rows: Math.min(rows.length, limit),
    durationMs,
  };
}

/** Did the rewrite actually change anything the planner cares about? */
export function compareEvidence(before: ExplainEvidence, after: ExplainEvidence): {
  improved: boolean;
  changed: string[];
} {
  const changed: string[] = [];
  if (before.fullScans.length !== after.fullScans.length) {
    changed.push(`full scans ${before.fullScans.length} -> ${after.fullScans.length}`);
  }
  if (before.indexSearches.length !== after.indexSearches.length) {
    changed.push(`index searches ${before.indexSearches.length} -> ${after.indexSearches.length}`);
  }
  if (after.durationMs < before.durationMs * 0.9) {
    changed.push(`time ${before.durationMs}ms -> ${after.durationMs}ms`);
  }
  const improved = after.fullScans.length < before.fullScans.length
    || after.indexSearches.length > before.indexSearches.length
    || after.durationMs < before.durationMs * 0.9;
  return { improved, changed };
}

export { tokenize };
