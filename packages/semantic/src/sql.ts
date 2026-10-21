/**
 * The model as something executable: lookups, join paths, and the two SQL shapes the probes need.
 *
 * Everything here is derived from the merged candidates - no separate definition of what a metric is. That
 * matters because the probe is the only thing standing between "the extractor read a formula" and "the
 * formula is the number the business means", and a probe that renders its own idea of the metric would test
 * nothing. So `renderTotal` and `renderByDimension` are also the seeds of the shared SQL layer (M3): P2 will
 * put the rewriter on top of exactly these strings.
 *
 * Joins come from the model's own `references` edges. There is no name-matching fallback: if the model does
 * not say how two tables relate, the renderer refuses and says which two tables it could not connect. A
 * generated `ON a.id = b.id` that happens to return rows is how a data agent gets a reputation for being
 * confidently wrong.
 */

import type { ColumnPayload, DimensionPayload, MetricPayload } from '../../contracts/src/index.ts';
import type { MergedCandidate } from './merge.ts';

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export interface ModelIndex {
  candidates: MergedCandidate[];
  byId: Map<string, MergedCandidate>;
  metrics: { id: string; payload: MetricPayload; status: import('../../contracts/src/index.ts').Candidate['status'] }[];
  dimensions: { id: string; payload: DimensionPayload; status: import('../../contracts/src/index.ts').Candidate['status'] }[];
  columns: Map<string, ColumnPayload>;
  tables: Set<string>;
  references: { from: string; to: string }[];
  groupedBy: { from: string; to: string }[];
  contributesTo: { from: string; to: string }[];
}

export interface RenderedQuery {
  sql: string;
  tables: string[];
  metric: string;
  dimension?: string;
  filters: string[];
  /** The FROM clause alone, so a caller can build a differently-shaped SELECT over the same joins. */
  from: string;
  /** `WHERE ...` with its leading space, or the empty string. */
  where: string;
  /** The metric's own aggregation expression. */
  expression: string;
  /** For a by-dimension render: the qualified dimension column. */
  dimColumn?: string;
}

export function indexModel(candidates: MergedCandidate[]): ModelIndex {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const metrics: ModelIndex['metrics'] = [];
  const dimensions: ModelIndex['dimensions'] = [];
  const columns = new Map<string, ColumnPayload>();
  const tables = new Set<string>();
  const references: ModelIndex['references'] = [];
  const groupedBy: ModelIndex['groupedBy'] = [];
  const contributesTo: ModelIndex['contributesTo'] = [];

  for (const candidate of candidates) {
    if (candidate.status === 'rejected') continue;
    if (candidate.kind === 'entity') {
      if (candidate.entityType === 'metric') {
        metrics.push({ id: candidate.id, payload: candidate.payload as MetricPayload, status: candidate.status });
      } else if (candidate.entityType === 'dimension') {
        dimensions.push({ id: candidate.id, payload: candidate.payload as DimensionPayload, status: candidate.status });
      } else if (candidate.entityType === 'column') {
        const payload = candidate.payload as ColumnPayload;
        columns.set(`${payload.table}.${payload.name}`, payload);
      } else if (candidate.entityType === 'table') {
        tables.add((candidate.payload as { name: string }).name);
      }
    } else {
      const from = candidate.from!;
      const to = candidate.to!;
      if (candidate.relationType === 'references') references.push({ from, to });
      if (candidate.relationType === 'groupedBy') groupedBy.push({ from, to });
      if (candidate.relationType === 'contributesTo') contributesTo.push({ from, to });
    }
  }

  return { candidates, byId, metrics, dimensions, columns, tables, references, groupedBy, contributesTo };
}

/** `SELECT <expression> AS value FROM <tables> [WHERE <口径>]`. */
export function renderTotal(index: ModelIndex, metricId: string, extraFilters: string[] = []): RenderedQuery {
  const metric = requireMetric(index, metricId);
  if (metric.payload.crossFact) {
    const rendered = renderCrossFact(index, metricId, [], { extraFilters });
    return rendered;
  }
  const filters = [...(metric.payload.filters ?? []), ...extraFilters];
  const { from, tables } = buildFrom(index, metric, undefined, filterTables(index, filters));
  const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
  return {
    sql: `SELECT ${metric.payload.expression} AS value FROM ${from}${where}`,
    tables,
    metric: metricId,
    filters,
    from,
    where,
    expression: metric.payload.expression,
  };
}

/**
 * The same render, grouped by several dimensions at once.
 *
 * The campaign agent has to price a *cell* (region x industry x channel) over time, and doing that as three
 * nested one-dimension queries would be both slower and wrong (it would need a join in JavaScript). One
 * statement with a multi-column GROUP BY is the honest translation of "the model says these slice a metric".
 */
export function renderByDimensions(index: ModelIndex, metricId: string, dimensionIds: string[],
  extraFilters: string[] = []): RenderedQuery & { dimColumns: string[] } {
  const metric = requireMetric(index, metricId);
  const dimensions = dimensionIds.map((id) => {
    const dimension = index.dimensions.find((entry) => entry.id === id);
    if (!dimension) throw new RenderError(`no dimension '${id}' in the model`);
    if (!dimension.payload.column) throw new RenderError(`dimension '${id}' has no bound column`);
    return { id, dimension };
  });
  if (dimensions.length === 0) throw new RenderError('renderByDimensions needs at least one dimension');

  const filters = [...(metric.payload.filters ?? []), ...extraFilters];
  // every dimension's table has to be joined, plus whatever the filters reference; the first one is the
  // dimension the join path is built around
  const columnIds = dimensions.map((entry) => entry.dimension.payload.column!);
  const base = columnIds[0]!;
  const extraTables = [
    ...new Set([
      ...columnIds.slice(1).map(tableOfColumnId),
      ...filterTables(index, filters),
    ]),
  ];
  const { from, tables } = buildFrom(index, metric, base, extraTables);
  const dimColumns = dimensions.map((entry) => dimensionValueExpr(entry.dimension.payload));
  const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
  const projection = dimColumns.map((column, position) => `${column} AS dim_${position}`).join(', ');
  const groupBy = dimColumns.map((_, position) => position + 1).join(', ');
  return {
    sql: `SELECT ${projection}, ${metric.payload.expression} AS value FROM ${from}${where} GROUP BY ${groupBy}`,
    tables,
    metric: metricId,
    filters,
    from,
    where,
    expression: metric.payload.expression,
    dimColumns,
    dimension: dimensions.map((entry) => entry.id).join('+'),
  };
}

/** `SELECT <dim column> AS dim_value, <expression> AS value ... GROUP BY <dim column>`. */
export function renderByDimension(index: ModelIndex, metricId: string, dimensionId: string,
  extraFilters: string[] = []): RenderedQuery {
  const metric = requireMetric(index, metricId);
  if (metric.payload.crossFact) return renderCrossFact(index, metricId, [dimensionId], { extraFilters });
  const dimension = index.dimensions.find((d) => d.id === dimensionId);
  if (!dimension) throw new RenderError(`no dimension '${dimensionId}' in the model`);
  const columnId = dimension.payload.column;
  if (!columnId) throw new RenderError(`dimension '${dimensionId}' has no bound column`);

  const filters = [...(metric.payload.filters ?? []), ...extraFilters];
  const { from, tables } = buildFrom(index, metric, columnId, filterTables(index, filters));
  // A time level is an expression over the column (`substr(date_key,1,7)` for month), not the column. The
  // stored expression is written against the bare column name and qualified here, so the model stays
  // readable while the SQL stays executable.
  const projected = dimensionValueExpr({ expression: dimension.payload.expression, column: columnId });
  const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
  return {
    sql: `SELECT ${projected} AS dim_value, ${metric.payload.expression} AS value FROM ${from}${where} GROUP BY ${projected} ORDER BY 1`,
    tables,
    metric: metricId,
    dimension: dimensionId,
    filters,
    from,
    where,
    expression: metric.payload.expression,
    dimColumn: projected,
  };
}

/**
 * The SQL an expression projects a dimension as, with the column qualified.
 *
 * A time level is an expression over the column (`substr(date_key,1,7)` for month), not the column itself.
 * The stored expression is written against the bare column name and qualified here, so the model stays
 * readable while the SQL stays executable. Exported because the attribution loop needs the same value for
 * its period axis as the renderer uses for its slice axis - two hand-written copies would drift.
 */
export function dimensionValueExpr(dimension: { expression?: string; column?: string }): string {
  if (!dimension.column) throw new RenderError('a dimension needs a bound column');
  const column = qualifyColumn(dimension.column);
  if (!dimension.expression) return column;
  const bareColumn = dimension.column.replace(/^column\//, '').split('.').pop() ?? '';
  return dimension.expression.replace(new RegExp(`\\b${escapeRegExp(bareColumn)}\\b`, 'g'), column);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The tables a filter's predicates reference.
 *
 * A filter is written table-qualified (`dim_channel.channel_name = '搜索'`), so re-slicing a slice needs that
 * table joined even though it is not the projected dimension. Without this the second level of an attribution
 * fails with "no such column", which is exactly the sub-query case requirement 8 warns about.
 */
function filterTables(index: ModelIndex, filters: string[]): string[] {
  const tables = new Set<string>();
  for (const filter of filters) {
    // identifiers may be quoted, and the renderer always quotes: `"dim_channel"."channel_name"`
    for (const match of filter.matchAll(/"?([A-Za-z_][\w]*)"?\s*\./g)) {
      const table = match[1]!;
      if (index.tables.has(table)) tables.add(table);
    }
  }
  return [...tables];
}

function requireMetric(index: ModelIndex, metricId: string): ModelIndex['metrics'][number] {
  const metric = index.metrics.find((m) => m.id === metricId);
  if (!metric) throw new RenderError(`no metric '${metricId}' in the model`);
  if (!metric.payload.expression) throw new RenderError(`metric '${metricId}' has no expression`);
  if (metric.payload.tables.length === 0) throw new RenderError(`metric '${metricId}' has no source table`);
  return metric;
}

/**
 * Builds the FROM clause, joining additional tables only over model-declared `references` edges.
 *
 * A dimension column may live in a different table than the measure; that is the normal case. The join it
 * needs is looked up in the model, and if there is none the error names both tables - which is the useful
 * half of the failure.
 */
function buildFrom(index: ModelIndex, metric: ModelIndex['metrics'][number], dimensionColumnId?: string,
  extraTables: string[] = []): { from: string; tables: string[] } {
  const baseTables = [...new Set(metric.payload.tables)];
  if (baseTables.length === 0) throw new RenderError(`metric '${metric.id}' has no tables`);
  const joined = [baseTables[0]!];
  const clauses: string[] = [];
  const pending = baseTables.slice(1);

  if (dimensionColumnId) {
    const table = tableOfColumnId(dimensionColumnId);
    if (!joined.includes(table)) pending.push(table);
  }
  for (const table of extraTables) {
    if (!joined.includes(table) && !pending.includes(table)) pending.push(table);
  }

  while (pending.length > 0) {
    const next = pending.shift()!;
    if (joined.includes(next)) continue;
    const join = findJoin(index, joined, next);
    if (!join) {
      throw new RenderError(`the model does not say how ${joined.join('/')} joins ${next}; add a references relation first`);
    }
    clauses.push(`JOIN ${next} ON ${qualifyColumn(join.from)} = ${qualifyColumn(join.to)}`);
    joined.push(next);
  }

  const from = [joined[0]!, ...clauses].join(' ');
  return { from, tables: joined };
}

function findJoin(index: ModelIndex, joined: string[], next: string): { from: string; to: string } | null {
  for (const relation of index.references) {
    const fromTable = tableOfColumnId(relation.from);
    const toTable = tableOfColumnId(relation.to);
    if (joined.includes(fromTable) && toTable === next) return relation;
    if (joined.includes(toTable) && fromTable === next) return { from: relation.to, to: relation.from };
  }
  return null;
}

/** `column/fact_ad_daily.spend` -> `fact_ad_daily.spend`, quoted per part. */
export function qualifyColumn(columnId: string): string {
  const name = columnId.replace(/^column\//, '');
  const dot = name.indexOf('.');
  if (dot < 0) throw new RenderError(`'${columnId}' is not a table.column column id`);
  return `${quote(name.slice(0, dot))}.${quote(name.slice(dot + 1))}`;
}

export function tableOfColumnId(columnId: string): string {
  const name = columnId.replace(/^column\//, '');
  const dot = name.indexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Cross-fact metrics: two facts, each aggregated at its own grain, combined on the dimensions they share.
 *
 * The wrong way to do this is a join between the two fact tables. Ads spend is at (day, region, industry,
 * channel); orders are at (order, region, industry). Joining them on region gives every order row a copy of
 * every ad row for that region, and both sums inflate — the classic fan-out, and the answer looks fine. So each
 * side is aggregated **before** anything is combined:
 *
 * ```sql
 * WITH n AS (SELECT <dims>, SUM(<numerator expression>) AS value FROM <numerator fact + joins>  WHERE ... GROUP BY <dims>),
 *      d AS (SELECT <dims>, SUM(<denominator expression>) AS value FROM <denominator fact + joins> WHERE ... GROUP BY <dims>)
 * SELECT n.d0 AS dim_value, n.value / NULLIF(d.value, 0) AS value FROM n JOIN d ON n.d0 = d.d0
 * ```
 *
 * Three things this file insists on:
 *
 * - **A shared dimension is one with a binding both sides can group by.** `dim/region` is (both facts reference
 *   `dim_region`); `dim/channel` is not (orders have no channel), and a time level is per-fact
 *   (`dim/month` belongs to the ad fact, `dim/fact_order_month` to the order fact). Requesting an unshared one is
 *   a {@link RenderError} that names the shared ones, not a query that silently drops a side.
 * - **The period filter is applied to each side through its own date column.** One predicate cannot serve two
 *   facts whose date columns differ; using the wrong one filters one side to zero and reports a clean "no data".
 * - **A zero denominator is NULL, not Infinity.** A ratio whose denominator is empty must read as missing.
 */
export interface CrossFactSide {
  metric: string;
  from: string;
  where: string;
  expression: string;
  tables: string[];
  columns: string[];
}

export interface CrossFactRendered extends RenderedQuery {
  sides: CrossFactSide[];
  crossFact: { numerator: string; denominator: string };
}

/** The dimensions a cross-fact metric can be sliced by: those both sides can group by. */
export function commonDimensions(index: ModelIndex, metricId: string): string[] {
  const metric = index.metrics.find((entry) => entry.id === metricId);
  if (!metric?.payload.crossFact) return [];
  const numeratorDims = new Set(index.groupedBy.filter((edge) => edge.from === metric.payload.crossFact!.numerator).map((edge) => edge.to));
  return index.groupedBy
    .filter((edge) => edge.from === metric.payload.crossFact!.denominator && numeratorDims.has(edge.to))
    .map((edge) => edge.to);
}

export function renderCrossFact(index: ModelIndex, metricId: string, dimensionIds: string[] = [],
  options: { extraFilters?: string[]; period?: { from: string; to: string } } = {}): CrossFactRendered {
  const metric = requireMetric(index, metricId);
  const crossFact = metric.payload.crossFact;
  if (!crossFact) throw new RenderError(`metric '${metricId}' is not a cross-fact metric`);

  const shared = new Set(commonDimensions(index, metricId));
  for (const id of dimensionIds) {
    if (!shared.has(id)) {
      throw new RenderError(`'${id}' is not a dimension both sides of ${metricId} can group by; shared: `
        + `${[...shared].join(', ') || '(none)'}`);
    }
  }

  // one dimension keeps the name every consumer already reads (`dim_value`); several get dim_0..dim_k
  const aliases = dimensionIds.map((_, position) => (dimensionIds.length === 1 ? 'dim_value' : `dim_${position}`));
  const sides = [
    renderCrossFactSide(index, crossFact.numerator, dimensionIds, aliases, 'numerator', options),
    renderCrossFactSide(index, crossFact.denominator, dimensionIds, aliases, 'denominator', options),
  ];
  const numerator = `(${sides[0]!.from}) n`;
  const denominator = `(${sides[1]!.from}) d`;
  // With dimensions: join the two aggregates on every shared key. Without: one row from each side.
  const sql = dimensionIds.length > 0
    ? `SELECT ${aliases.map((alias) => `n.${alias} AS ${alias}`).join(', ')}, n.value / NULLIF(d.value, 0) AS value`
      + ` FROM ${numerator} JOIN ${denominator}`
      + ` ON ${aliases.map((alias) => `n.${alias} = d.${alias}`).join(' AND ')}`
      + ` ORDER BY ${aliases.map((alias) => `n.${alias}`).join(', ')}`
    : `SELECT n.value / NULLIF(d.value, 0) AS value FROM ${numerator} CROSS JOIN ${denominator}`;

  return {
    sql,
    tables: [...new Set([...sides[0]!.tables, ...sides[1]!.tables])],
    metric: metricId,
    ...(dimensionIds.length > 0 ? { dimension: dimensionIds.join('+') } : {}),
    filters: [...(metric.payload.filters ?? []), ...(options.extraFilters ?? [])],
    from: `${numerator} ${denominator}`,
    where: '',
    expression: `${crossFact.numerator} / ${crossFact.denominator}`,
    ...(dimensionIds.length > 0 ? { dimColumn: aliases[0] } : {}),
    sides,
    crossFact,
  };
}

/** One side of a cross-fact metric, already aggregated to the requested dimensions and period. */
function renderCrossFactSide(index: ModelIndex, metricId: string, dimensionIds: string[], aliases: string[],
  role: 'numerator' | 'denominator',
  options: { extraFilters?: string[]; period?: { from: string; to: string } }): CrossFactSide {
  const sideMetric = index.metrics.find((entry) => entry.id === metricId);
  if (!sideMetric) throw new RenderError(`cross-fact side '${metricId}' is not a metric in the model`);
  const side = sideMetric.payload;
  const dimensionColumns = dimensionIds.map((id) => {
    const dimension = index.dimensions.find((entry) => entry.id === id);
    if (!dimension?.payload.column) throw new RenderError(`dimension '${id}' has no bound column`);
    return { id, column: dimension.payload.column, expression: dimensionValueExpr(dimension.payload) };
  });

  const filters = [...(side.filters ?? []), ...(options.extraFilters ?? [])];
  const period = options.period ? periodPredicate(index, metricId, options.period) : null;
  if (options.period && !period) {
    throw new RenderError(`${metricId} has no month-level date dimension, so the period '${options.period.from}..${options.period.to}' `
      + 'cannot be applied to its side of the cross-fact metric');
  }

  const requestedColumns = dimensionColumns.map((dimension) => dimension.column);
  const { from, tables } = buildFrom(index, sideMetric, requestedColumns[0], [
    ...new Set([...requestedColumns.slice(1).map(tableOfColumnId), ...filterTables(index, [...filters, ...(period ? [period] : [])])]),
  ]);
  const whereParts = [...filters, ...(period ? [period] : [])];
  const where = whereParts.length > 0 ? ` WHERE ${whereParts.map((part) => `(${part})`).join(' AND ')}` : '';
  const dims = dimensionColumns.length > 0
    ? `${dimensionColumns.map((dimension, position) => `${dimension.expression} AS ${aliases[position]}`).join(', ')}, `
    : '';
  const groupBy = dimensionColumns.length > 0 ? ` GROUP BY ${dimensionColumns.map((_, position) => position + 1).join(', ')}` : '';

  return {
    metric: metricId,
    from: `SELECT ${dims}${side.expression} AS value FROM ${from}${where}${groupBy}`,
    where,
    expression: side.expression,
    tables,
    columns: side.columns,
  };
}

/** The period predicate for one side, read off that side's own month dimension. */
function periodPredicate(index: ModelIndex, metricId: string, period: { from: string; to: string }): string | null {
  const timeDimension = index.dimensions.find((dimension) =>
    dimension.payload.level === 'month'
    && index.groupedBy.some((edge) => edge.from === metricId && edge.to === dimension.id)
    && dimension.payload.column !== undefined);
  if (!timeDimension?.payload.column) return null;
  const column = qualifyColumn(timeDimension.payload.column);
  return `${column} >= '${period.from}' AND ${column} < '${period.to}'`;
}
