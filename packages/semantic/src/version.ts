/**
 * Model evolution: what changed between two revisions, whether it breaks anyone, and whether the change is real.
 *
 * A semantic layer is a contract with every query written against it, and the dangerous releases are not the loud
 * ones (a removed metric shows up as a refusal) but the quiet ones: the same metric name, a slightly different
 * expression, and every trend on the dashboard steps because the denominator changed. Three tools here:
 *
 * | tool | question |
 * | --- | --- |
 * | `diffModels` | what changed, and who consumes it? A removal is graded by its consumers, not by its existence |
 * | `driftReport` | does the physical schema still look like what the model claims? |
 * | `shadowAsk` | the same question under both revisions: do the numbers move, and by how much? |
 *
 * The classification is deliberately mechanical. `expression` changing is *breaking* even when the new expression
 * looks better, because "looks better" is a judgement and the dashboards do not make it. Adding a metric or a
 * description is compatible; rebinding a dimension is behavioural (the numbers are right, the grouping changed);
 * removing something with no consumers is still recorded, but it no longer blocks a release.
 */

import type { MergedCandidate } from './merge.ts';
import { indexModel } from './sql.ts';
import { ask, type AskResult } from './ask/index.ts';
import type { AgentRefusal } from '../../core/src/result.ts';

export type Compatibility = 'compatible' | 'behavioural' | 'breaking';

export interface Change {
  kind: 'added' | 'removed' | 'changed' | 'status';
  target: 'metric' | 'dimension' | 'column' | 'table' | 'relation' | 'query';
  id: string;
  /** Which payload field moved (`expression`, `column`, `status`, ...). */
  field?: string;
  before?: unknown;
  after?: unknown;
  compatibility: Compatibility;
  reason: string;
  /** Ids that would notice: metrics reading a column, dimensions bound to it, relations touching a table. */
  consumers: string[];
}

export interface ModelDiff {
  from: { revision: number | null; counts: ModelCounts };
  to: { revision: number | null; counts: ModelCounts };
  changes: Change[];
  summary: { added: number; removed: number; changed: number; breaking: number; behavioural: number };
  /** The release verdict: one breaking change is enough, and there is no "mostly fine". */
  verdict: Compatibility;
}

export interface ModelCounts {
  tables: number;
  columns: number;
  metrics: number;
  dimensions: number;
  relations: number;
}

export interface LiveTable {
  name: string;
  columns: { name: string; type: string }[];
}

export interface DriftIssue {
  kind: 'missing-table' | 'missing-column' | 'type-changed' | 'new-column' | 'undeclared-table';
  target: string;
  detail: string;
  blocking: boolean;
}

export interface DriftReport {
  checked: { tables: number; columns: number };
  issues: DriftIssue[];
  verdict: 'ok' | 'drift';
  blocking: number;
}

export interface ShadowResult {
  question: string;
  previous: RevisionAnswer;
  next: RevisionAnswer;
  comparison: {
    /** Rows that only exist in one answer, or whose value moved beyond the tolerance. */
    rowsChanged: number;
    rowsCompared: number;
    maxRelativeDelta: number;
    /** A move big enough to change a decision: any row beyond 1e-6 relative, or a different row set. */
    material: boolean;
  };
  /** `promote` only when both answered and nothing material moved. */
  verdict: 'promote' | 'hold';
  reasons: string[];
}

interface RevisionAnswer {
  revision: number | null;
  rows: { value: unknown; measure: number }[];
  total: number;
  refused: AgentRefusal[];
  sql: string[];
}

const TARGETS: Record<string, Change['target']> = {
  metric: 'metric', dimension: 'dimension', column: 'column', table: 'table', query: 'query',
};

function targetOf(id: string): Change['target'] {
  const prefix = id.split('/')[0] ?? '';
  return TARGETS[prefix] ?? (id.includes('|') ? 'relation' : 'column');
}

export function modelCounts(candidates: MergedCandidate[]): ModelCounts {
  const live = candidates.filter((candidate) => candidate.status !== 'rejected');
  const count = (prefix: string) => live.filter((candidate) => candidate.id.startsWith(`${prefix}/`)).length;
  return {
    tables: count('table'),
    columns: count('column'),
    metrics: count('metric'),
    dimensions: count('dim'),
    relations: live.filter((candidate) => candidate.kind === 'relation').length,
  };
}

/**
 * Compares two revisions of the same model.
 *
 * `previous` and `next` are the merged candidate lists (what `build` writes to `candidates.json`), so a release can
 * be graded before anything is published - the diff is a property of the model, not of the graph.
 */
export function diffModels(previous: MergedCandidate[], next: MergedCandidate[], revisions: { from?: number | null; to?: number | null } = {}): ModelDiff {
  const before = new Map(previous.map((candidate) => [candidate.id, candidate]));
  const after = new Map(next.map((candidate) => [candidate.id, candidate]));
  const consumers = consumerIndex(next);
  const changes: Change[] = [];

  for (const [id, candidate] of before) {
    const other = after.get(id);
    if (!other) {
      const target = targetOf(id);
      const users = consumers.get(id) ?? [];
      const compatibility: Compatibility = target === 'relation'
        ? (users.length > 0 ? 'breaking' : 'behavioural')
        : (users.length > 0 ? 'breaking' : 'behavioural');
      changes.push({
        kind: 'removed', target, id, compatibility,
        reason: users.length === 0
          ? 'removed with no consumers: nothing breaks, but the removal is on the record'
          : `removed while ${users.length} thing(s) still reference it: ${users.slice(0, 3).join(', ')}`,
        consumers: users,
      });
      continue;
    }
    if (candidate.status !== other.status) {
      const disappeared = candidate.status !== 'rejected' && other.status === 'rejected';
      changes.push({
        kind: 'status', target: targetOf(id), id, field: 'status',
        before: candidate.status, after: other.status,
        compatibility: disappeared ? 'breaking' : 'compatible',
        reason: disappeared ? 'the item disappeared from the model: every query using it now refuses' : 'the item became available',
        consumers: consumers.get(id) ?? [],
      });
    }
    for (const field of ['expression', 'tables', 'formula', 'crossFact', 'aggFunction', 'filters', 'column', 'level', 'dataType', 'isGrain'] as const) {
      const left = (candidate.payload as Record<string, unknown>)[field];
      const right = (other.payload as Record<string, unknown>)[field];
      if (JSON.stringify(left) === JSON.stringify(right)) continue;
      if (left === undefined && right === undefined) continue;
      const compatibility = gradeField(field, left, right);
      changes.push({
        kind: 'changed', target: targetOf(id), id, field, before: left, after: right,
        compatibility,
        reason: reasonFor(field, compatibility),
        consumers: consumers.get(id) ?? [],
      });
    }
  }

  for (const [id] of after) {
    if (before.has(id)) continue;
    changes.push({
      kind: 'added', target: targetOf(id), id, compatibility: 'compatible',
      reason: 'new item: additive, nothing that existed changes meaning',
      consumers: [],
    });
  }

  const breaking = changes.filter((change) => change.compatibility === 'breaking').length;
  const behavioural = changes.filter((change) => change.compatibility === 'behavioural').length;
  return {
    from: { revision: revisions.from ?? null, counts: modelCounts(previous) },
    to: { revision: revisions.to ?? null, counts: modelCounts(next) },
    changes,
    summary: {
      added: changes.filter((change) => change.kind === 'added').length,
      removed: changes.filter((change) => change.kind === 'removed').length,
      changed: changes.filter((change) => change.kind === 'changed').length,
      breaking,
      behavioural,
    },
    verdict: breaking > 0 ? 'breaking' : behavioural > 0 ? 'behavioural' : 'compatible',
  };
}

function gradeField(field: string, before: unknown, after: unknown): Compatibility {
  switch (field) {
    // the number changes; every consumer's history steps, even if the new definition is "better"
    case 'expression':
    case 'formula':
    case 'crossFact':
    case 'aggFunction':
    case 'filters':
    case 'tables':
      return 'breaking';
    // the number stays right, the grouping or the join changes
    case 'column':
    case 'level':
      return 'behavioural';
    default:
      return typeof before === typeof after ? 'compatible' : 'behavioural';
  }
}

function reasonFor(field: string, compatibility: Compatibility): string {
  if (compatibility === 'breaking') {
    return field === 'tables'
      ? 'the source tables changed: the metric now reads a different fact, so its history is not comparable'
      : `${field} changed: the definition moved, so every trend through it steps at the release`;
  }
  if (compatibility === 'behavioural') {
    return `${field} changed: same numbers, different grouping or join path`;
  }
  return `${field} changed without moving a number`;
}

/** Who points at whom: metric -> its tables/columns, dimension -> its column, relation -> both ends. */
function consumerIndex(candidates: MergedCandidate[]): Map<string, string[]> {
  const consumers = new Map<string, string[]>();
  const note = (target: string, by: string) => {
    const list = consumers.get(target) ?? [];
    if (!list.includes(by)) list.push(by);
    consumers.set(target, list);
  };
  for (const candidate of candidates) {
    if (candidate.status === 'rejected') continue;
    const payload = candidate.payload as Record<string, unknown>;
    if (candidate.id.startsWith('metric/')) {
      for (const table of (payload.tables as string[] | undefined) ?? []) note(`table/${table}`, candidate.id);
      for (const column of (payload.columns as string[] | undefined) ?? []) note(`column/${column}`, candidate.id);
    }
    if (candidate.id.startsWith('dim/') && typeof payload.column === 'string') note(payload.column, candidate.id);
    if (candidate.kind === 'relation') {
      if (candidate.from) note(candidate.from, candidate.id);
      if (candidate.to) note(candidate.to, candidate.id);
    }
  }
  return consumers;
}

/**
 * Compares the model's claims with the tables that actually exist.
 *
 * `live` comes from the warehouse's own catalog (`PRAGMA table_info` in SQLite, `information_schema` elsewhere), so
 * this is the one check in the repository that cannot be fooled by the model agreeing with itself.
 */
export function driftReport(
  candidates: MergedCandidate[],
  live: LiveTable[],
  options: { ignoreExtraColumns?: boolean } = {},
): DriftReport {
  const declared = new Map<string, Map<string, string>>();
  for (const candidate of candidates) {
    if (candidate.status === 'rejected') continue;
    if (!candidate.id.startsWith('column/')) continue;
    const payload = candidate.payload as { table?: string; name?: string; dataType?: string };
    if (!payload.table || !payload.name) continue;
    const columns = declared.get(payload.table) ?? new Map<string, string>();
    // '' means "presence only": a column the extractor could not type is still worth checking for existence
    columns.set(payload.name, payload.dataType ?? '');
    declared.set(payload.table, columns);
  }

  const liveByName = new Map(live.map((table) => [table.name, new Map(table.columns.map((column) => [column.name, column.type]))]));
  const issues: DriftIssue[] = [];
  let checkedTables = 0;
  let checkedColumns = 0;

  for (const [table, columns] of declared) {
    const actual = liveByName.get(table);
    if (!actual) {
      issues.push({ kind: 'missing-table', target: `table/${table}`, detail: 'the model declares this table; the warehouse does not have it', blocking: true });
      continue;
    }
    checkedTables++;
    for (const [column, type] of columns) {
      checkedColumns++;
      const actualType = actual.get(column);
      if (actualType === undefined) {
        issues.push({ kind: 'missing-column', target: `column/${table}.${column}`, detail: 'declared by the model, absent from the warehouse', blocking: true });
        continue;
      }
      if (type !== '' && !sameType(type, actualType)) {
        issues.push({
          kind: 'type-changed', target: `column/${table}.${column}`,
          detail: `model says ${type}, warehouse says ${actualType}`,
          // widening text->number is not safe to assume: an expression written for a string can return NULL
          blocking: true,
        });
      }
    }
    for (const column of actual.keys()) {
      if (columns.has(column)) continue;
      issues.push({
        kind: 'new-column', target: `column/${table}.${column}`, detail: 'in the warehouse but not in the model: available, unused',
        blocking: options.ignoreExtraColumns === true ? false : false,
      });
    }
  }
  for (const table of liveByName.keys()) {
    if (declared.has(table)) continue;
    issues.push({ kind: 'undeclared-table', target: `table/${table}`, detail: 'in the warehouse but not modelled', blocking: false });
  }

  const blocking = issues.filter((issue) => issue.blocking).length;
  return {
    checked: { tables: checkedTables, columns: checkedColumns },
    issues,
    verdict: blocking > 0 ? 'drift' : 'ok',
    blocking,
  };
}

/** SQLite's type names against the DDL's: the same affinity, spelled differently, is not drift. */
function sameType(declared: string, actual: string): boolean {
  const normalise = (type: string): string => {
    const upper = type.toUpperCase();
    if (upper.includes('INT')) return 'integer';
    if (upper.includes('CHAR') || upper.includes('TEXT') || upper.includes('CLOB') || upper.includes('DATE')) return 'text';
    if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB') || upper.includes('DEC') || upper.includes('NUM')) return 'number';
    if (upper.includes('BLOB')) return 'blob';
    return upper.toLowerCase();
  };
  return normalise(declared) === normalise(actual);
}

export interface ReleaseDecision {
  verdict: 'promote' | 'hold' | 'reject';
  reasons: string[];
  checks: { diff: Compatibility; drift: DriftReport['verdict']; shadow: ShadowResult['verdict'] | 'not-run' };
}

/**
 * The gate in front of a release: a breaking diff needs a shadow run that shows no material movement, and a drifted
 * warehouse stops everything. The three verdicts are kept separate in the output so a reader can see which one
 * blocked, rather than a single "not allowed" that hides the reason.
 */
export function releaseGate(input: {
  diff: ModelDiff;
  drift: DriftReport;
  shadows?: ShadowResult[];
}): ReleaseDecision {
  const reasons: string[] = [];
  const shadows = input.shadows ?? [];
  if (input.drift.verdict === 'drift') {
    reasons.push(`the warehouse drifted from the model: ${input.drift.blocking} blocking issue(s)`);
  }
  if (input.diff.verdict === 'breaking') {
    reasons.push(`the diff is breaking: ${input.diff.summary.breaking} change(s) move a defined number`);
  }
  for (const shadow of shadows) {
    if (shadow.verdict === 'hold') reasons.push(`shadow "${shadow.question}": ${shadow.reasons.join('; ')}`);
  }
  if (input.drift.verdict === 'drift' || input.diff.verdict === 'breaking') {
    // a breaking diff is only releasable with evidence: at least one shadow question that came back identical
    const identical = shadows.filter((shadow) => shadow.verdict === 'promote').length;
    if (input.drift.verdict === 'drift') return { verdict: 'reject', reasons, checks: { diff: input.diff.verdict, drift: input.drift.verdict, shadow: shadows.length === 0 ? 'not-run' : shadows.every((shadow) => shadow.verdict === 'promote') ? 'promote' : 'hold' } };
    if (identical === 0) reasons.push('no shadow question was run: a breaking change with no evidence is a hold, not a release');
    return { verdict: 'hold', reasons, checks: { diff: input.diff.verdict, drift: input.drift.verdict, shadow: shadows.length === 0 ? 'not-run' : 'hold' } };
  }
  return { verdict: 'promote', reasons: reasons.length === 0 ? ['compatible diff, no drift, shadows identical'] : reasons, checks: { diff: input.diff.verdict, drift: input.drift.verdict, shadow: shadows.length === 0 ? 'not-run' : 'promote' } };
}

/**
 * Shadow mode: the same question, two revisions, side by side.
 *
 * This is the release primitive. A breaking diff says "numbers may move"; this says "here are the numbers, and here
 * is how far they moved". Promotion is refused when either revision refuses to answer (a refactor that breaks the
 * vocabulary is not a release) or when any row moves beyond the tolerance.
 */
export function shadowAsk(input: {
  question: string;
  previous: MergedCandidate[];
  next: MergedCandidate[];
  run: Parameters<typeof ask>[0]['run'];
  revisions?: { from?: number | null; to?: number | null };
  tolerance?: number;
  now?: Date;
}): ShadowResult {
  const tolerance = input.tolerance ?? 1e-6;
  const answer = (candidates: MergedCandidate[], revision: number | null): RevisionAnswer => {
    const result = ask({ question: input.question, index: indexModel(candidates), run: input.run, modelRevision: revision, ...(input.now ? { now: input.now } : {}) });
    if ('refusals' in result && !('plan' in result)) {
      return { revision, rows: [], total: 0, refused: result.refusals, sql: [] };
    }
    const asked = result as AskResult;
    return { revision, rows: asked.answer.rows, total: asked.answer.total, refused: [], sql: asked.plan.sql };
  };
  const previous = answer(input.previous, input.revisions?.from ?? null);
  const next = answer(input.next, input.revisions?.to ?? null);

  const reasons: string[] = [];
  if (previous.refused.length > 0) reasons.push(`the previous revision refuses: ${previous.refused.map((refusal) => refusal.code).join(', ')}`);
  if (next.refused.length > 0) reasons.push(`the next revision refuses: ${next.refused.map((refusal) => refusal.code).join(', ')}`);

  const byKey = new Map(previous.rows.map((row) => [String(row.value), row.measure]));
  const nextByKey = new Map(next.rows.map((row) => [String(row.value), row.measure]));
  const keys = new Set([...byKey.keys(), ...nextByKey.keys()]);
  let rowsChanged = 0;
  let maxRelativeDelta = 0;
  for (const key of keys) {
    const left = byKey.get(key);
    const right = nextByKey.get(key);
    if (left === undefined || right === undefined) {
      rowsChanged++;
      maxRelativeDelta = Number.POSITIVE_INFINITY;
      continue;
    }
    const relative = Math.abs(right - left) / Math.max(Math.abs(left), 1e-9);
    maxRelativeDelta = Math.max(maxRelativeDelta, relative);
    if (relative > tolerance) rowsChanged++;
  }
  const material = rowsChanged > 0 || previous.refused.length > 0 || next.refused.length > 0;
  if (material && rowsChanged > 0) reasons.push(`${rowsChanged} of ${keys.size} rows moved (max relative ${Number.isFinite(maxRelativeDelta) ? maxRelativeDelta.toExponential(2) : 'infinity'})`);
  if (!material) reasons.push('every row is identical under both revisions');

  return {
    question: input.question,
    previous,
    next,
    comparison: { rowsChanged, rowsCompared: keys.size, maxRelativeDelta, material },
    verdict: material ? 'hold' : 'promote',
    reasons,
  };
}
