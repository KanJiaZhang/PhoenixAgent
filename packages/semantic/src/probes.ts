/**
 * The probes: the difference between a model that reads well and a model that is true.
 *
 * Five things can be checked against the warehouse, and each one answers a different doubt:
 *
 * | probe | the doubt it settles |
 * | --- | --- |
 * | `existence` | "does this column/table/expression even compile?" - a typo in an ETL metric dies here |
 * | `references` | "does this FK actually join the data?" - counts the match rate, because a declared FK is a claim about rows, not syntax |
 * | `groupedBy` | "is the metric additive over this dimension?" - total vs sum of the slices; a multiplicative or duplicated metric fails |
 * | `golden` | "is the number right?" - compared against the fixture's independently computed value |
 * | `formula` | "is this ratio really its two drivers?" - checked per slice, which is what makes a `contributesTo` edge safe to use for attribution |
 *
 * A verdict is `pass`, `weak`, `fail`, `skipped` or `error`, and the two last ones are reported rather than
 * hidden: a probe that cannot run (no data, no join path, a ratio probe on a base metric) is a gap in the
 * evidence, and calling it a pass would be the one thing this product must not do.
 *
 * Every probe carries the SQL it ran, so "why is this 0.31" is answerable by copying the query.
 */

import type { Catalog, QueryRunner } from '../../dataplane/src/sqlite.ts';
import type { ProbeResult } from '../../contracts/src/index.ts';
import { RenderError, indexModel, renderByDimension, renderTotal, type ModelIndex } from './sql.ts';

export interface ProbeContext {
  run: QueryRunner;
  catalog: Catalog;
  candidates: Parameters<typeof indexModel>[0];
  /** Independently computed metric values from the fixture builder. Missing names are simply not checked. */
  goldens?: { metrics?: Record<string, number> };
  thresholds?: { joinMatchRate?: number; relativeError?: number };
}

const DEFAULTS = { joinMatchRate: 0.95, relativeError: 1e-6 };

export function runProbes(context: ProbeContext): ProbeResult[] {
  const index = indexModel(context.candidates);
  const thresholds = { ...DEFAULTS, ...context.thresholds };
  const results: ProbeResult[] = [];

  results.push(...existenceProbes(context, index));
  results.push(...referenceProbes(context, index, thresholds.joinMatchRate));
  results.push(...metricProbes(context, index, thresholds.relativeError));
  results.push(...groupedByProbes(context, index, thresholds.relativeError));
  results.push(...attributionProbes(index));
  results.push(...grainProbes(context, index));
  results.push(...enumProbes(context, index));

  // stable order makes the report diffable, which is what a regression run needs
  return results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- existence ---------------------------------------------------------------------------------------

function existenceProbes(context: ProbeContext, index: ModelIndex): ProbeResult[] {
  const results: ProbeResult[] = [];
  const catalogTables = new Set(context.catalog.tables.map((t) => t.name));

  for (const candidate of index.candidates) {
    if (candidate.status === 'rejected') continue;

    // --- structural relations: nothing to run, but both endpoints must exist in the model or the catalog
    if (candidate.kind === 'relation') {
      if (!STRUCTURAL.has(candidate.relationType ?? '')) continue;
      const missing: string[] = [];
      for (const endpoint of [candidate.from ?? '', candidate.to ?? '']) {
        if (!endpointExists(endpoint, context, index)) missing.push(endpoint);
      }
      results.push({
        id: `existence:${candidate.id}`,
        probe: 'existence',
        target: candidate.id,
        status: missing.length === 0 ? 'pass' : 'fail',
        detail: missing.length === 0
          ? 'both endpoints exist'
          : `endpoint(s) do not exist: ${missing.join(', ')}`,
      });
      continue;
    }

    if (candidate.kind !== 'entity') continue;

    if (candidate.entityType === 'table') {
      const name = (candidate.payload as { name: string }).name;
      results.push(compile(`existence:${candidate.id}`, 'existence', candidate.id,
        `SELECT 1 FROM "${name}" LIMIT 0`, context,
        catalogTables.has(name) ? null : `table '${name}' is not in the catalog`));
    }

    if (candidate.entityType === 'column') {
      const payload = candidate.payload as { table: string; name: string };
      const sql = `SELECT "${payload.name}" FROM "${payload.table}" LIMIT 0`;
      const inCatalog = context.catalog.tables
        .find((t) => t.name === payload.table)?.columns.some((c) => c.name === payload.name) ?? false;
      results.push(compile(`existence:${candidate.id}`, 'existence', candidate.id, sql, context,
        inCatalog ? null : `column '${payload.table}.${payload.name}' is not in the catalog`));
    }

    if (candidate.entityType === 'metric') {
      const payload = candidate.payload as { expression?: string; tables?: string[] };
      if (!payload.expression || (payload.tables ?? []).length === 0) {
        // a documented metric with no SQL is a gap, not a failure: it is already counted by coverage
        results.push({
          id: `existence:${candidate.id}`, probe: 'existence', target: candidate.id, status: 'skipped',
          detail: 'no executable definition yet (this candidate is waiting for review)',
        });
        continue;
      }
      // the compile check: an expression that names a column nobody has cannot be run, let alone trusted
      let sql: string;
      try {
        sql = `${renderTotal(index, candidate.id).sql} LIMIT 0`;
      } catch (error) {
        results.push({
          id: `existence:${candidate.id}`,
          probe: 'existence',
          target: candidate.id,
          status: 'error',
          detail: (error as Error).message,
        });
        continue;
      }
      results.push(compile(`existence:${candidate.id}`, 'existence', candidate.id, sql, context, null));
    }

    if (candidate.entityType === 'dimension') {
      const payload = candidate.payload as { column?: string };
      if (!payload.column) {
        results.push({
          id: `existence:${candidate.id}`,
          probe: 'existence',
          target: candidate.id,
          status: 'skipped',
          detail: 'the dimension has no bound column, so there is nothing to check',
        });
        continue;
      }
      const [table, column] = payload.column.replace(/^column\//, '').split('.');
      const inCatalog = context.catalog.tables
        .find((t) => t.name === table)?.columns.some((c) => c.name === column) ?? false;
      results.push(compile(`existence:${candidate.id}`, 'existence', candidate.id,
        `SELECT "${column}" FROM "${table}" LIMIT 0`, context,
        inCatalog ? null : `dimension column '${payload.column}' is not in the catalog`));
    }
  }
  return results;
}

/** The relation types whose correctness is about existence rather than about rows. */
const STRUCTURAL = new Set([
  'contains', 'partOf', 'usesColumn', 'computedFrom', 'dimensionColumn', 'definedBy', 'governedBy',
  'synonymOf', 'derivedFrom', 'writes', 'hierarchy', 'belongsTo', 'hasMetric',
]);

function endpointExists(id: string, context: ProbeContext, index: ModelIndex): boolean {
  if (id.startsWith('column/')) {
    const [table, column] = id.replace(/^column\//, '').split('.');
    return context.catalog.tables.some((entry) => entry.name === table && entry.columns.some((c) => c.name === column));
  }
  if (id.startsWith('table/')) {
    return context.catalog.tables.some((entry) => entry.name === id.replace(/^table\//, ''));
  }
  return index.byId.has(id);
}

function compile(id: string, probe: ProbeResult['probe'], target: string, sql: string, context: ProbeContext,
  failure: string | null): ProbeResult {
  if (failure) {
    return { id, probe, target, status: 'fail', detail: failure, sql };
  }
  try {
    const started = performance.now();
    context.run(sql);
    return {
      id, probe, target, status: 'pass',
      detail: 'compiles and runs',
      sql,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    };
  } catch (error) {
    return { id, probe, target, status: 'fail', detail: (error as Error).message, sql };
  }
}

// --- references --------------------------------------------------------------------------------------

function referenceProbes(context: ProbeContext, index: ModelIndex, threshold: number): ProbeResult[] {
  const results: ProbeResult[] = [];
  for (const relation of index.references) {
    const relationId = `${relation.from}|references|${relation.to}`;
    const candidate = index.byId.get(relationId);
    if (candidate && candidate.status === 'rejected') continue;
    const [childTable, childColumn] = relation.from.replace(/^column\//, '').split('.');
    const [parentTable, parentColumn] = relation.to.replace(/^column\//, '').split('.');
    if (!childTable || !childColumn || !parentTable || !parentColumn) continue;

    const sql = `SELECT COUNT(*) AS total, `
      + `SUM(CASE WHEN "${parentTable}"."${parentColumn}" IS NOT NULL THEN 1 ELSE 0 END) AS matched `
      + `FROM "${childTable}" LEFT JOIN "${parentTable}" `
      + `ON "${childTable}"."${childColumn}" = "${parentTable}"."${parentColumn}"`;

    const started = performance.now();
    try {
      const result = context.run(sql);
      const row = result.rows[0] ?? {};
      const total = Number(row.total ?? 0);
      const matched = Number(row.matched ?? 0);
      const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
      if (total === 0) {
        results.push({
          id: `references:${relationId}`, probe: 'references', target: relationId, status: 'skipped',
          detail: 'the child table has no rows, so the match rate proves nothing', sql, durationMs,
        });
        continue;
      }
      const value = Math.round((matched / total) * 1e6) / 1e6;
      results.push({
        id: `references:${relationId}`,
        probe: 'references',
        target: relationId,
        status: value >= threshold ? 'pass' : value >= 0.5 ? 'weak' : 'fail',
        value,
        threshold,
        detail: `${matched}/${total} child rows find a parent (${(value * 100).toFixed(2)}%)`,
        sql,
        durationMs,
      });
    } catch (error) {
      results.push({
        id: `references:${relationId}`, probe: 'references', target: relationId, status: 'error',
        detail: (error as Error).message, sql,
      });
    }
  }
  return results;
}

// --- metrics: value, and the ratio identity ----------------------------------------------------------

function metricProbes(context: ProbeContext, index: ModelIndex, tolerance: number): ProbeResult[] {
  const results: ProbeResult[] = [];
  const goldens = context.goldens?.metrics ?? {};

  for (const metric of index.metrics) {
    const candidate = index.byId.get(metric.id);
    if (candidate?.status === 'rejected') continue;

    // --- golden: the number the fixture computed independently
    const golden = goldens[metric.payload.name];
    if (typeof golden === 'number') {
      let sql: string;
      try {
        sql = renderTotal(index, metric.id).sql;
      } catch (error) {
        results.push({
          id: `golden:${metric.id}`, probe: 'golden', target: metric.id, status: 'error',
          detail: (error as Error).message,
        });
        continue;
      }
      try {
        const result = context.run(sql);
        const value = Number(result.rows[0]?.value ?? NaN);
        const error = relativeError(value, golden);
        results.push({
          id: `golden:${metric.id}`,
          probe: 'golden',
          target: metric.id,
          status: Number.isFinite(error) && error <= tolerance ? 'pass' : 'fail',
          value: Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : undefined,
          threshold: tolerance,
          detail: `computed ${value} vs golden ${golden} (relative error ${error})`,
          sql,
          durationMs: result.durationMs,
        });
      } catch (error) {
        results.push({
          id: `golden:${metric.id}`, probe: 'golden', target: metric.id, status: 'fail',
          detail: `the metric does not run: ${(error as Error).message}`, sql,
        });
      }
    }

    // --- formula: a ratio must equal its own two sides, slice by slice
    if (metric.payload.metricKind === 'ratio' && metric.payload.formula) {
      const dimension = pickDimension(index, metric.id);
      let sql: string;
      try {
        const base = dimension ? renderByDimension(index, metric.id, dimension) : renderTotal(index, metric.id);
        const { numerator, denominator } = metric.payload.formula;
        const group = base.dimColumn ? ` GROUP BY ${base.dimColumn}` : '';
        sql = `SELECT ${numerator} / NULLIF(${denominator}, 0) AS recomputed, ${base.expression} AS declared FROM ${base.from}${base.where}${group}`;
      } catch (error) {
        results.push({
          id: `formula:${metric.id}`, probe: 'formula', target: metric.id, status: 'error',
          detail: (error as Error).message,
        });
        continue;
      }
      try {
        const result = context.run(sql);
        let worst = 0;
        for (const row of result.rows) {
          worst = Math.max(worst, relativeError(Number(row.recomputed ?? NaN), Number(row.declared ?? NaN)));
        }
        results.push({
          id: `formula:${metric.id}`,
          probe: 'formula',
          target: metric.id,
          status: worst <= 1e-6 ? 'pass' : 'fail',
          value: Number.isFinite(worst) ? Math.round(worst * 1e6) / 1e6 : undefined,
          threshold: 1e-6,
          detail: `${result.rowCount} slice(s) checked, worst relative error ${worst}${dimension ? ` over ${dimension}` : ''}`,
          sql,
          durationMs: result.durationMs,
        });
      } catch (error) {
        results.push({
          id: `formula:${metric.id}`, probe: 'formula', target: metric.id, status: 'error',
          detail: (error as Error).message, sql,
        });
      }
    }
  }
  return results;
}

/** The dimension a ratio probe slices by: region if the model has it, otherwise the first one. */function pickDimension(index: ModelIndex, metricId: string): string | null {
  const slices = index.groupedBy.filter((edge) => edge.from === metricId).map((edge) => edge.to);
  if (slices.length === 0) return null;
  return slices.find((id) => id === 'dim/region') ?? slices[0]!;
}

// --- groupedBy: additivity ---------------------------------------------------------------------------
function groupedByProbes(context: ProbeContext, index: ModelIndex, tolerance: number): ProbeResult[] {
  const results: ProbeResult[] = [];
  const additive = new Set(['SUM', 'COUNT']);

  for (const edge of index.groupedBy) {
    const metric = index.metrics.find((m) => m.id === edge.from);
    if (!metric) continue;
    const candidate = index.byId.get(metric.id);
    if (candidate?.status === 'rejected') continue;
    const relationId = `${edge.from}|groupedBy|${edge.to}`;

    if (!additive.has(metric.payload.aggFunction)) {
      results.push({
        id: `groupedBy:${relationId}`, probe: 'groupedBy', target: relationId, status: 'skipped',
        detail: `a ${metric.payload.aggFunction} metric is not additive, so summing its slices is not a check`,
      });
      continue;
    }

    let totalSql: string;
    let sliceSql: string;
    try {
      totalSql = renderTotal(index, metric.id).sql;
      sliceSql = renderByDimension(index, metric.id, edge.to).sql;
    } catch (error) {
      results.push({
        id: `groupedBy:${relationId}`, probe: 'groupedBy', target: relationId, status: 'error',
        detail: (error as Error).message,
      });
      continue;
    }

    const sql = `SELECT COALESCE((${totalSql}), 0) AS total, COALESCE((SELECT SUM(value) FROM (${sliceSql})), 0) AS sliced`;
    const started = performance.now();
    try {
      const row = context.run(sql).rows[0] ?? {};
      const total = Number(row.total ?? NaN);
      const sliced = Number(row.sliced ?? NaN);
      const error = relativeError(total, sliced);
      results.push({
        id: `groupedBy:${relationId}`,
        probe: 'groupedBy',
        target: relationId,
        status: Number.isFinite(error) && error <= tolerance ? 'pass' : 'fail',
        value: Number.isFinite(error) ? Math.round(error * 1e9) / 1e9 : undefined,
        threshold: tolerance,
        detail: `total ${total} vs sum of ${edge.to} slices ${sliced} (relative error ${error})`,
        sql,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      });
    } catch (error) {
      results.push({
        id: `groupedBy:${relationId}`, probe: 'groupedBy', target: relationId, status: 'error',
        detail: (error as Error).message, sql,
      });
    }
  }
  return results;
}

/** `|a - b| / max(|b|, tiny)`, so a 0-versus-0 comparison is "equal", not "infinite error". */
export function relativeError(actual: number, expected: number): number {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return Number.NaN;
  const scale = Math.max(Math.abs(expected), 1e-12);
  return Math.abs(actual - expected) / scale;
}

export { RenderError };

// --- contributesTo: does the parent metric's own definition mention the child? -------------------------

/**
 * An attribution edge is a claim about arithmetic: "this driver moves that outcome". It can be checked
 * without any data at all - if ROI's definition divides revenue by spend, then `revenue contributesTo roi` is
 * supported by the metric's own formula, and a driver that appears nowhere in the parent's definition is only
 * a sentence somebody wrote.
 *
 * So the verdict is `pass` when the parent's expression or formula mentions the child's columns, and `weak`
 * when it does not. Nothing is ever `fail` here: a weak edge is not wrong, it is unproven, and saying so is
 * the point. Attribution will refuse to lean on a weak edge for a numeric claim.
 */
function attributionProbes(index: ModelIndex): ProbeResult[] {
  const results: ProbeResult[] = [];
  for (const edge of index.contributesTo) {
    const parent = index.metrics.find((metric) => metric.id === edge.to);
    const child = index.metrics.find((metric) => metric.id === edge.from);
    const relationId = `${edge.from}|contributesTo|${edge.to}`;
    if (!parent || !child) {
      results.push({
        id: `formula:${relationId}`, probe: 'formula', target: relationId, status: 'skipped',
        detail: 'both ends of the attribution edge have to be metrics in the model',
      });
      continue;
    }
    const definition = [parent.payload.expression, parent.payload.formula?.numerator, parent.payload.formula?.denominator]
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
    const mentioned = child.payload.columns.filter((column) => {
      const name = column.replace(/^column\//, '').split('.').pop();
      return name !== undefined && definition.includes(name);
    });
    results.push({
      id: `formula:${relationId}`,
      probe: 'formula',
      target: relationId,
      status: mentioned.length > 0 ? 'pass' : 'weak',
      value: mentioned.length,
      detail: mentioned.length > 0
        ? `${child.id} appears in the definition of ${parent.id} (${mentioned.join(', ')})`
        : `${child.id} is claimed as a driver of ${parent.id}, but ${parent.id}'s definition never mentions its columns`,
    });
  }
  return results;
}


// --- grain: is the declared key actually unique? -------------------------------------------------------

/**
 * The most expensive silent error in analytics is a "fact table" whose declared grain is not unique: every sum
 * is then inflated by the fan-out, and nothing about the answer looks wrong.
 *
 * So the declared grain is executed: `COUNT(*) - COUNT(DISTINCT key...)`. Zero duplicates is the only pass.
 * A table with no declared key is reported as skipped, not as passing - an unproven grain is a gap.
 */
function grainProbes(context: ProbeContext, index: ModelIndex): ProbeResult[] {
  const results: ProbeResult[] = [];
  for (const candidate of index.candidates) {
    if (candidate.entityType !== 'table' || candidate.status === 'rejected') continue;
    const payload = candidate.payload as { grain?: string[] };
    const grain = payload.grain ?? [];
    const table = (candidate.payload as { name: string }).name;
    if (grain.length === 0) {
      results.push({
        id: `grain:${candidate.id}`, probe: 'grain', target: candidate.id, status: 'skipped',
        detail: 'no primary key is declared, so there is no grain to prove (counts on this table cannot be trusted yet)',
      });
      continue;
    }
    const known = new Set(context.catalog.tables.find((entry) => entry.name === table)?.columns.map((column) => column.name) ?? []);
    const missing = grain.filter((column) => !known.has(column));
    if (missing.length > 0) {
      results.push({
        id: `grain:${candidate.id}`, probe: 'grain', target: candidate.id, status: 'fail',
        detail: `the declared grain names column(s) the catalog does not have: ${missing.join(', ')}`,
      });
      continue;
    }
    const columns = grain.map((column) => `"${column}"`).join(', ');
    const sql = `SELECT COUNT(*) AS total, COUNT(*) - (SELECT COUNT(*) FROM (SELECT DISTINCT ${columns} FROM "${table}")) AS duplicates FROM "${table}"`;
    const started = performance.now();
    try {
      const row = context.run(sql).rows[0] ?? {};
      const duplicates = Number(row.duplicates ?? 0);
      results.push({
        id: `grain:${candidate.id}`,
        probe: 'grain',
        target: candidate.id,
        status: duplicates === 0 ? 'pass' : 'fail',
        value: duplicates,
        threshold: 0,
        detail: duplicates === 0
          ? `(${grain.join(', ')}) identifies every row (${row.total} rows)`
          : `(${grain.join(', ')}) is not unique: ${duplicates} duplicate key combinations`,
        sql,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      });
    } catch (error) {
      results.push({
        id: `grain:${candidate.id}`, probe: 'grain', target: candidate.id, status: 'error',
        detail: (error as Error).message, sql,
      });
    }
  }
  return results;
}

// --- enum: the literal in a 口径 filter has to be a value that occurs --------------------------------

/**
 * `WHERE status = 'paid'` is part of a metric's definition. If no row has that value - a typo, a renamed
 * status, a value the upstream team stopped emitting - the metric is silently zero, and a zero is worse than a
 * refusal because it looks like an answer.
 *
 * The probe is one count per literal filter: it does not claim the filter is *right*, only that it is not
 * dead.
 */
function enumProbes(context: ProbeContext, index: ModelIndex): ProbeResult[] {
  const results: ProbeResult[] = [];
  for (const metric of index.metrics) {
    const candidate = index.byId.get(metric.id);
    if (candidate?.status === 'rejected') continue;
    for (const filter of metric.payload.filters ?? []) {
      const match = /^\s*(\w+)\.(\w+)\s*=\s*'([^']*)'\s*$/.exec(filter);
      if (!match) continue;
      const [, table, column, value] = match;
      const sql = `SELECT COUNT(*) AS matched FROM "${table}" WHERE "${table}"."${column}" = '${value.replace(/'/g, "''")}'`;
      try {
        const row = context.run(sql).rows[0] ?? {};
        const matched = Number(row.matched ?? 0);
        results.push({
          id: `enum:${metric.id}:${column}:${value}`,
          probe: 'enum',
          target: metric.id,
          status: matched > 0 ? 'pass' : 'fail',
          value: matched,
          detail: matched > 0
            ? `口径过滤条件 '${filter}' matches ${matched} rows`
            : `口径过滤条件 '${filter}' matches no row: the metric would answer 0 for a reason nobody can see`,
          sql,
        });
      } catch (error) {
        results.push({
          id: `enum:${metric.id}:${column}:${value}`, probe: 'enum', target: metric.id, status: 'error',
          detail: (error as Error).message, sql,
        });
      }
    }
  }
  return results;
}
