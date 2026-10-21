/**
 * The attribution loop: what moved, which driver and which slice, and what is still unexplained.
 *
 * The shape is a **budgeted loop over the semantic model**, not a fixed query:
 *
 * ```
 * node(metric, filters, depth):
 *   one query  -> period totals (and, per dimension, every slice at once)
 *   choose the decomposition the model can support   (ratio / additive / association)
 *   score      -> contribution, share, belowThreshold
 *   prune      -> drop what is below the reporting threshold, stop when nothing is left
 *   expand     -> recurse into the top driver, or re-slice the top slice
 *   emit       -> explained, unexplained, the SQL, the depth
 * ```
 *
 * Three things this file is careful about, because each is a way attribution goes wrong:
 *
 * 1. **Batching.** A slice is never one query. One query returns every slice of one dimension for both
 *    periods (`GROUP BY period, slice`), so a dimension with 288 dates costs one round trip, not 576. The
 *    result carries `naiveQueries` next to `queries` so the saving is a number, not a claim.
 * 2. **Residuals.** When the decomposition is additive or a ratio, the parts are summed and compared with the
 *    total. A non-zero remainder is reported as `unexplained` with its share - it is never quietly absorbed
 *    into the "top driver", and it never rounds to "100% explained".
 * 3. **No causality.** The output says "this slice accounts for 63% of the change", and a `limits` entry says
 *    the analysis is descriptive. The words "because" and "caused" do not appear in generated text.
 */

import {
  RenderError,
  dimensionValueExpr,
  indexModel,
  renderByDimension,
  renderCrossFact,
  renderTotal,
  type ModelIndex,
} from '../../../semantic/src/sql.ts';
import type { QueryRunner } from '../../../dataplane/src/sqlite.ts';
import type { AgentRefusal } from '../../../core/src/result.ts';
import { additiveResidual, decomposeRatio, round } from './decompose.ts';
import { narrate } from './narrate.ts';
import type { MergedCandidate } from '../../../semantic/src/merge.ts';

export interface AttributeOptions {
  /** Metric id or short name. */
  metric: string;
  /** Period labels on the period dimension, e.g. `2025-10`. */
  from: string;
  to: string;
  run: QueryRunner;
  /** Which semantic model to attribute over. */
  candidates?: MergedCandidate[];
  index?: ModelIndex;
  /** `auto` uses drivers when the model has them, slices otherwise. */
  mode?: 'auto' | 'drivers' | 'slices';
  /** Restrict the driver set (the "what if one driver is missing" case). */
  drivers?: string[];
  /** Restrict the slice dimensions. */
  dimensions?: string[];
  periodDimension?: string;
  maxDepth?: number;
  maxQueries?: number;
  maxMs?: number;
  /** Below this share of the total change, a candidate is not worth mentioning. */
  pruneShare?: number;
  /** Above this share, the loop recurses into the candidate. */
  expandShare?: number;
  topK?: number;
  now?: string;
}

export interface DriverContribution {
  metric: string;
  role: 'numerator' | 'denominator' | 'driver';
  /** How the driver enters the parent's formula: `+1` adds, `-1` subtracts, `0` not found in it. */
  sign: 1 | -1 | 0;
  /** False for a ratio: the two effects are exact but they cancel, so a share of Δ means nothing. */
  shareMeaningful: boolean;
  previous: number;
  current: number;
  delta: number;
  contribution: number;
  share: number;
  belowThreshold: boolean;
}

export interface SliceContribution {
  value: unknown;
  previous: number;
  current: number;
  delta: number;
  contribution: number;
  share: number;
  belowThreshold: boolean;
}

export interface SliceSet {
  dimension: string;
  items: SliceContribution[];
  /** What this dimension would have cost one-slice-at-a-time: `items × 2 periods`. */
  naiveQueries: number;
  /** One. The whole point of batching. */
  batchedQueries: number;
}

export interface AttributionNode {
  metric: string;
  depth: number;
  filters: string[];
  /** A readable name for the drilled subset, e.g. `channel = 搜索`; absent at the root. */
  label?: string;
  previous: number;
  current: number;
  delta: number;
  decomposition: 'additive' | 'ratio' | 'association' | 'none';
  drivers: DriverContribution[];
  sliceSets: SliceSet[];
  unexplained: { absolute: number; share: number } | null;
  children: AttributionNode[];
  queries: number;
  note?: string;
}

export interface AttributionResult {
  agent: 'attribution';
  metric: string;
  period: { dimension: string; from: string; to: string };
  root: AttributionNode;
  /** The path the loop actually followed, root first. */
  path: AttributionNode[];
  explanation: string;
  limits: string[];
  confidence: { score: number; warnings: string[] };
  cost: { queries: number; naiveQueries: number; rows: number; ms: number; iterations: number };
  refusals: AgentRefusal[];
  evidence: { sql: string[] };
}

const DEFAULTS = {
  maxDepth: 2,
  maxQueries: 40,
  maxMs: 5_000,
  pruneShare: 0.02,
  expandShare: 0.25,
  topK: 1,
  dimensionsPerNode: 3,
};

interface Budget {
  queries: number;
  naiveQueries: number;
  rows: number;
  started: number;
  maxQueries: number;
  maxMs: number;
  sql: string[];
  iterations: number;
}

export function attribute(options: AttributeOptions): AttributionResult {
  const index = options.index ?? indexModel(options.candidates ?? []);
  const settings = { ...DEFAULTS, ...pickSettings(options) };
  const budget: Budget = {
    queries: 0, naiveQueries: 0, rows: 0, started: performance.now(),
    maxQueries: settings.maxQueries, maxMs: settings.maxMs, sql: [], iterations: 0,
  };

  const resolved = resolveMetric(index, options.metric);
  const metric = resolved ? index.metrics.find((entry) => entry.id === resolved.id) : undefined;
  if (!metric) {
    return refusal(index, options, 'no-such-metric',
      `the model has no metric '${options.metric}'`,
      index.metrics.map((entry) => entry.id).join(', '));
  }

  // The period axis is the metric's own month level - except for a cross-fact metric, whose slices are the
  // dimensions *both* facts share (no time among them). There the axis comes from either side, and the
  // cross-fact renderer applies the window to each side through its own date column.
  const ownSlices = index.groupedBy.filter((edge) => edge.from === metric.id).map((edge) => edge.to);
  const sideSlices = metric.payload.crossFact
    ? [metric.payload.crossFact.numerator, metric.payload.crossFact.denominator]
      .flatMap((side) => index.groupedBy.filter((edge) => edge.from === side).map((edge) => edge.to))
    : [];
  const pickLevel = (ids: string[], level: string) => ids.find((id) =>
    index.dimensions.find((dimension) => dimension.id === id)?.payload.level === level);
  const periodDimension = options.periodDimension
    ?? pickLevel(ownSlices, 'month') ?? pickLevel(sideSlices, 'month')
    ?? pickLevel(ownSlices, 'year') ?? pickLevel(sideSlices, 'year');

  if (!periodDimension) {
    return refusal(index, options, 'not-in-model',
      `${metric.id} has no time level to compare periods on`,
      'add a month/year dimension over its date column (the catalog does this from a DATE column)');
  }

  let root: AttributionNode;
  try {
    root = runNode({
      index, run: options.run, metric: metric.id, filters: [], depth: 0, periodDimension,
      from: options.from, to: options.to, settings, budget,
      mode: options.mode ?? 'auto',
      allowedDrivers: options.drivers,
      allowedSlices: options.dimensions,
      dimensionsUsed: new Set([periodDimension]),
    });
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      return refusal(index, options, 'budget', error.message, 'raise maxQueries/maxMs or lower maxDepth');
    }
    if (error instanceof RenderError) {
      return refusal(index, options, 'not-in-model', error.message, 'add the missing relation or binding');
    }
    throw error;
  }
  if (options.mode === 'drivers' && root.drivers.length === 0) {
    return refusal(index, options, 'not-in-model',
      `${metric.id} has no contributesTo edge, so there is no driver to attribute the change to`,
      'declare the relationship in the model (a document sentence or a human candidate), or use mode=auto to slice instead');
  }

  const path = collectPath(root);
  const explanation = narrate({ metric: metric.id, from: options.from, to: options.to, root, path });
  const warnings: string[] = [];
  if (root.unexplained && Math.abs(root.unexplained.share) > 0.01) {
    warnings.push(`${(root.unexplained.share * 100).toFixed(1)}% of the change is unexplained by this decomposition`);
  }
  if (root.decomposition === 'association') {
    warnings.push('the model has no formula for this metric, so the drivers are reported as co-movement, not as a decomposition');
  }
  if (budget.queries >= budget.maxQueries) warnings.push('the query budget was exhausted; deeper levels were not explored');

  return {
    agent: 'attribution',
    metric: metric.id,
    period: { dimension: periodDimension, from: options.from, to: options.to },
    root,
    path,
    explanation,
    limits: [
      '这是分解归因（descriptive decomposition），不是因果结论',
      '贡献份额只说明"该切片的变动占总量变动的比例"，不说明驱动机制',
      '阈值是报告阈值，不是统计显著性检验',
    ],
    confidence: {
      score: Math.max(0.2, 0.95 - 0.1 * path.length - (root.unexplained && Math.abs(root.unexplained.share) > 0.05 ? 0.15 : 0)),
      warnings,
    },
    cost: {
      queries: budget.queries,
      naiveQueries: budget.naiveQueries,
      rows: budget.rows,
      ms: Math.round(performance.now() - budget.started),
      iterations: budget.iterations,
    },
    refusals: [],
    evidence: { sql: budget.sql },
  };
}

class BudgetExceeded extends Error {}

interface NodeArgs {
  index: ModelIndex;
  run: QueryRunner;
  metric: string;
  filters: string[];
  depth: number;
  periodDimension: string;
  from: string;
  to: string;
  settings: typeof DEFAULTS;
  budget: Budget;
  mode: 'auto' | 'drivers' | 'slices';
  allowedDrivers?: string[];
  allowedSlices?: string[];
  dimensionsUsed: Set<string>;
}

function runNode(args: NodeArgs): AttributionNode {
  const { index, metric, filters, depth, periodDimension, from, to, settings, budget } = args;
  budget.iterations++;
  const metricEntry = index.metrics.find((entry) => entry.id === metric);
  if (!metricEntry) throw new RenderError(`no metric '${metric}'`);

  const queriesAtStart = budget.queries;
  const node: AttributionNode = {
    metric, depth, filters,
    previous: 0, current: 0, delta: 0,
    decomposition: 'none', drivers: [], sliceSets: [], unexplained: null, children: [], queries: 0,
  };

  // --- the node's own totals: one query
  const totals = querySeries(args, metric, periodDimension, undefined, args.filters);
  const previous = periodValue(totals, from);
  const current = periodValue(totals, to);
  node.previous = round(previous);
  node.current = round(current);
  node.delta = round(current - previous);
  node.queries = budget.queries - queriesAtStart;

  // --- drivers, from the model's contributesTo edges (direction: driver -> this metric)
  // A cross-fact ratio declares its two sides as metric ids, so the drivers are known exactly - no column
  // matching needed (and none would work: the "expression" is `metric/a / metric/b`).
  const crossFact = metricEntry.payload.crossFact;
  const drivers = crossFact
    ? [crossFact.numerator, crossFact.denominator].filter((id) => index.metrics.some((entry) => entry.id === id))
    : (args.allowedDrivers ?? index.contributesTo.filter((edge) => edge.to === metric).map((edge) => edge.from))
      .filter((id) => index.metrics.some((entry) => entry.id === id));

  if (args.mode === 'drivers' && drivers.length === 0) {
    node.note = `${metric} has no contributesTo edge; nothing to attribute it to`;
    return node;
  }

  if (drivers.length > 0 && args.mode !== 'slices') {
    Object.assign(node, attributeDrivers(args, metric, drivers, previous, current));
    if (node.decomposition !== 'none') {
      maybeExpand(args, node);
      return node;
    }
  }

  // --- slices: one query per dimension, every slice at once
  attributeSlices(args, node, metricEntry.payload.metricKind === 'ratio');
  if (node.drivers.length === 0 && node.sliceSets.length === 0) {
    node.note = `${metric} has neither a contributesTo driver nor a non-time dimension to slice by`;
  }
  maybeExpand(args, node);
  return node;
}

function attributeDrivers(args: NodeArgs, metric: string, drivers: string[], previous: number, current: number):
Pick<AttributionNode, 'decomposition' | 'drivers' | 'unexplained'> {
  const { index } = args;
  const metricEntry = index.metrics.find((entry) => entry.id === metric)!;
  const values: { id: string; previous: number; current: number }[] = [];

  for (const driver of drivers) {
    // A driver may live on a different fact table than the metric being explained (cross-fact ratios do this by
    // definition), and a period predicate built from the *parent's* date column would reference a table the
    // driver does not read. So each driver gets its own month level.
    const series = querySeries(args, driver, monthDimOf(index, driver) ?? args.periodDimension, undefined, args.filters);
    values.push({ id: driver, previous: periodValue(series, args.from), current: periodValue(series, args.to) });
  }

  const crossFact = metricEntry.payload.crossFact;
  if (metricEntry.payload.metricKind === 'ratio' && (metricEntry.payload.formula || crossFact)) {
    // Which side is the numerator? For a SQL ratio the formula names two expressions and the driver whose columns
    // appear in the numerator is it; for a cross-fact ratio the two sides are metric ids outright.
    const formula = metricEntry.payload.formula ?? { numerator: '', denominator: '' };
    const numeratorDrivers = crossFact
      ? values.filter((value) => value.id === crossFact.numerator)
      : values.filter((value) => expressionMentions(index, value.id, formula.numerator));
    const denominatorDrivers = crossFact
      ? values.filter((value) => value.id === crossFact.denominator)
      : values.filter((value) => expressionMentions(index, value.id, formula.denominator));
    if (numeratorDrivers.length === 1 && denominatorDrivers.length === 1) {
      const numerator = numeratorDrivers[0]!;
      const denominator = denominatorDrivers[0]!;
      const effects = decomposeRatio({
        numeratorPrevious: numerator.previous,
        numeratorCurrent: numerator.current,
        denominatorPrevious: denominator.previous,
        denominatorCurrent: denominator.current,
      });
      const totalDelta = current - previous;
      const contributions = [
        { metric: numerator.id, role: 'numerator' as const, previous: numerator.previous, current: numerator.current,
          delta: numerator.current - numerator.previous, contribution: effects.numeratorEffect },
        { metric: denominator.id, role: 'denominator' as const, previous: denominator.previous, current: denominator.current,
          delta: denominator.current - denominator.previous, contribution: effects.denominatorEffect },
      ].map((entry) => ({
        ...entry,
        sign: 1 as const,
        shareMeaningful: false,
        contribution: round(entry.contribution),
        share: totalDelta === 0 ? 0 : round(entry.contribution / totalDelta),
        // a ratio effect is pruned by its size relative to the total change, not by its share of it
        belowThreshold: totalDelta === 0 || Math.abs(entry.contribution) < Math.abs(totalDelta) * args.settings.pruneShare,
      }));
      return {
        decomposition: 'ratio',
        drivers: contributions,
        // an exact decomposition has no residual; a non-zero one would be a bug worth surfacing
        unexplained: { absolute: round(effects.residual), share: totalDelta === 0 ? 0 : round(effects.residual / totalDelta) },
      };
    }
  }

  // A sum over drivers is additive only when the drivers are *signed* the way the formula signs them:
  // `GMV = SUM(amount - refund_amount)` means a rise in refunds lowers GMV, and a decomposition that adds
  // every driver's delta would report "explained 123%" without noticing.
  const totalDelta = current - previous;
  const movements = values.map((value) => {
    const sign = driverSign(index, metric, value.id);
    const delta = value.current - value.previous;
    return {
      metric: value.id,
      role: 'driver' as const,
      sign,
      shareMeaningful: sign !== 0,
      previous: round(value.previous),
      current: round(value.current),
      delta: round(delta),
      contribution: round(sign * delta),
      share: totalDelta === 0 || sign === 0 ? 0 : round((sign * delta) / totalDelta),
      belowThreshold: totalDelta === 0 || sign === 0
        || Math.abs((sign * delta) / totalDelta) < args.settings.pruneShare,
    };
  });
  const additive = metricEntry.payload.additive === true
    || (index.byId.get(metric)?.payload as { aggFunction?: string } | undefined)?.aggFunction === 'SUM';
  const signed = movements.every((entry) => entry.sign !== 0);
  const residual = additiveResidual(totalDelta, movements.map((entry) => entry.contribution));

  if (additive && signed) {
    // the residual is reported, whatever its size: a driver set that covers 88% of the change is exactly the
    // case a reader needs to know about
    return {
      decomposition: 'additive',
      drivers: movements,
      unexplained: { absolute: round(residual.residual), share: totalDelta === 0 ? 0 : round(residual.residual / totalDelta) },
    };
  }

  // Not additive, or the formula does not say how each driver enters: report the co-movement, and refuse to
  // call it a decomposition.
  return { decomposition: 'association', drivers: movements, unexplained: null };
}

function attributeSlices(args: NodeArgs, node: AttributionNode, isRatio: boolean): void {
  const { index, budget, settings } = args;
  const dimensions = (args.allowedSlices ?? index.groupedBy.filter((edge) => edge.from === node.metric).map((edge) => edge.to))
    .filter((id) => !args.dimensionsUsed.has(id))
    .filter((id) => index.dimensions.some((dimension) => dimension.id === id))
    // a time level is the axis of the comparison, not a slice of it: slicing by day would produce one slice
    // per date and call the top one "the driver", which is true and useless
    .filter((id) => {
      if (args.allowedSlices !== undefined) return true;
      const dimension = index.dimensions.find((entry) => entry.id === id);
      // a time level is the axis of the comparison, not a slice of it
      return dimension?.payload.level === undefined && !/DATE|TIMESTAMP/i.test(dimension?.payload.dataType ?? '');
    })
    .slice(0, DEFAULTS.dimensionsPerNode);

  for (const dimensionId of dimensions) {
    const rows = querySeries(args, node.metric, args.periodDimension, dimensionId, args.filters);
    const previous = new Map<string, number>();
    const current = new Map<string, number>();
    for (const row of rows) {
      const key = String(row.dim_value);
      const value = Number(row.value ?? 0);
      if (String(row.period) === args.from) previous.set(key, value);
      if (String(row.period) === args.to) current.set(key, value);
    }
    const keys = [...new Set([...previous.keys(), ...current.keys()])];
    // the batched query returned every slice; the naive alternative would be one query per slice per period
    budget.naiveQueries += keys.length * 2;
    if (keys.length === 0) continue;

    const items: SliceContribution[] = keys.map((key) => {
      const before = previous.get(key) ?? 0;
      const after = current.get(key) ?? 0;
      const delta = after - before;
      const share = node.delta === 0 ? 0 : delta / node.delta;
      return {
        value: coerce(key),
        previous: round(before),
        current: round(after),
        delta: round(delta),
        contribution: round(delta),
        share: round(share),
        belowThreshold: node.delta !== 0 && Math.abs(share) < settings.pruneShare,
      };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    node.sliceSets.push({ dimension: dimensionId, items, naiveQueries: keys.length * 2, batchedQueries: 1 });
    if (!isRatio && node.delta !== 0) {
      // a sum of slices is a decomposition only when the slices cover the metric
      const residual = additiveResidual(node.delta, items.map((item) => item.contribution));
      const share = node.delta === 0 ? 0 : residual.residual / node.delta;
      if (node.unexplained === null || Math.abs(share) > Math.abs(node.unexplained.share)) {
        node.unexplained = { absolute: round(residual.residual), share: round(share) };
      }
      node.decomposition = 'additive';
    } else if (isRatio) {
      // slicing a ratio: the slices are informational, not additive, and the node says so
      if (node.decomposition === 'none') node.decomposition = 'association';
      if (node.unexplained === null) node.unexplained = null;
    }
  }
}

/** Recurse into the strongest candidate: a driver metric, or the top slice with another dimension. */
function maybeExpand(args: NodeArgs, node: AttributionNode): void {
  const { settings, budget, index } = args;
  if (node.depth >= settings.maxDepth) return;
  if (budget.queries >= budget.maxQueries || performance.now() - budget.started >= settings.maxMs) return;

  const ratio = node.decomposition === 'ratio';
  const driver = [...node.drivers].sort((a, b) => (ratio
    ? Math.abs(b.contribution) - Math.abs(a.contribution)
    : Math.abs(b.share) - Math.abs(a.share)))[0];
  const strongEnough = driver !== undefined && (ratio
    ? Math.abs(driver.contribution) >= Math.abs(node.delta) * settings.expandShare
    : Math.abs(driver.share) >= settings.expandShare);
  if (driver && strongEnough) {
    node.children.push(runNode({
      ...args,
      metric: driver.metric,
      depth: node.depth + 1,
      // a driver on another fact needs its own period axis, and the restriction was about *this* node's drivers
      periodDimension: monthDimOf(index, driver.metric) ?? args.periodDimension,
      allowedDrivers: undefined,
      dimensionsUsed: new Set([args.periodDimension]),
    }));
    return;
  }

  const sliceSet = [...node.sliceSets].sort((a, b) => Math.abs(b.items[0]?.delta ?? 0) - Math.abs(a.items[0]?.delta ?? 0))[0];
  const top = sliceSet?.items[0];
  if (sliceSet && top && Math.abs(top.share) >= settings.expandShare) {
    const dimension = index.dimensions.find((entry) => entry.id === sliceSet.dimension);
    if (!dimension?.payload.column) return;
    const valueExpr = dimensionValueExpr(dimension.payload);
    const literal = typeof top.value === 'number' ? String(top.value) : `'${String(top.value).replace(/'/g, "''")}'`;
    const filter = `${valueExpr} = ${literal}`;
    if (node.delta === 0) return;
    const child = runNode({
      ...args,
      metric: node.metric,
      filters: [...node.filters, filter],
      depth: node.depth + 1,
      dimensionsUsed: new Set([...args.dimensionsUsed, sliceSet.dimension]),
    });
    child.label = `${sliceSet.dimension.replace(/^dim\//, '')} = ${String(top.value)}`;
    node.children.push(child);
  }
}

interface SeriesRow {
  period: unknown;
  dim_value?: unknown;
  value: unknown;
}

/** One query: both periods, and — when a dimension is given — every slice at once. */
function querySeries(args: NodeArgs, metric: string, periodDimension: string, dimensionId: string | undefined,
  filters: string[]): SeriesRow[] {
  const { index, budget } = args;
  if (budget.queries >= budget.maxQueries) throw new BudgetExceeded(`query budget of ${budget.maxQueries} exhausted`);
  if (performance.now() - budget.started >= budget.maxMs) throw new BudgetExceeded(`time budget of ${budget.maxMs} ms exhausted`);

  const period = index.dimensions.find((entry) => entry.id === periodDimension);
  if (!period) throw new RenderError(`no period dimension '${periodDimension}'`);
  const periodExpr = dimensionValueExpr(period.payload);
  // The period predicate goes through the renderer like any other filter, so the table it reads is joined.
  const periodCondition = `${periodExpr} IN (${quote(args.from)}, ${quote(args.to)})`;
  const allFilters = [...filters, periodCondition];
  const metricEntry = index.metrics.find((entry) => entry.id === metric);
  if (metricEntry?.payload.crossFact) {
    // one statement per period; each side gets its own date column, so both are filtered correctly
    const rows: SeriesRow[] = [];
    for (const label of [args.from, args.to]) {
      const window = monthWindow(label);
      const rendered = renderCrossFact(index, metric, dimensionId ? [dimensionId] : [],
        { extraFilters: filters, period: window });
      budget.queries++;
      budget.sql.push(rendered.sql);
      const result = args.run(rendered.sql);
      budget.rows += result.rows.length;
      for (const row of result.rows) {
        rows.push({ period: label, dim_value: row.dim_value, value: row.value } as SeriesRow);
      }
    }
    return rows;
  }

  const base = dimensionId
    ? renderByDimension(index, metric, dimensionId, allFilters)
    : renderTotal(index, metric, allFilters);
  const metricExpr = base.expression;
  const sliceExpr = dimensionId ? base.dimColumn! : null;
  const projection = sliceExpr
    ? `SELECT ${periodExpr} AS period, ${sliceExpr} AS dim_value, ${metricExpr} AS value FROM ${base.from}${base.where} GROUP BY 1, 2`
    : `SELECT ${periodExpr} AS period, NULL AS dim_value, ${metricExpr} AS value FROM ${base.from}${base.where} GROUP BY 1`;

  budget.queries++;
  budget.sql.push(projection);
  let result;
  try {
    result = args.run(projection);
  } catch (error) {
    // the SQL is part of the failure: without it "no such column" is a bug report, with it a fix
    throw new Error(`${(error as Error).message}
SQL: ${projection}`);
  }
  budget.rows += result.rows.length;
  return result.rows as unknown as SeriesRow[];
}

function periodValue(rows: SeriesRow[], period: string): number {
  const row = rows.find((entry) => String(entry.period) === period);
  return row ? Number(row.value ?? 0) : 0;
}

/** The month-level dimension of one metric, or null. */
function monthDimOf(index: ModelIndex, metricId: string): string | null {
  const slices = index.groupedBy.filter((edge) => edge.from === metricId).map((edge) => edge.to);
  const month = slices.find((id) => index.dimensions.find((dimension) => dimension.id === id)?.payload.level === 'month');
  if (month) return month;
  const year = slices.find((id) => index.dimensions.find((dimension) => dimension.id === id)?.payload.level === 'year');
  return year ?? null;
}

/** `2025-10` -> `{ from: '2025-10-01', to: '2025-11-01' }`. */
function monthWindow(label: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(label.slice(0, 7));
  if (!match) return { from: label, to: label };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { from: `${year}-${String(month).padStart(2, '0')}-01`, to: next };
}

function quote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function coerce(value: string): unknown {
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

/**
 * The sign a driver carries in its parent's formula, read from the expression.
 *
 * `-` immediately before the driver's (qualified) column means it is subtracted; a bare reference is added.
 * Not finding the column at all returns 0, which downgrades the parent to `association` - a driver the parent
 * never mentions has no sign to claim.
 */
function driverSign(index: ModelIndex, parentId: string, childId: string): 1 | -1 | 0 {
  const parent = index.metrics.find((entry) => entry.id === parentId)?.payload;
  const child = index.metrics.find((entry) => entry.id === childId)?.payload;
  if (!parent?.expression || !child) return 0;
  const columns = (child.columns ?? [])
    .map((column) => column.replace(/^column\//, '').split('.').pop() ?? '')
    .filter((column) => column.length > 0);
  if (columns.length === 0) return 0;

  for (const column of columns) {
    const pattern = new RegExp(`(-|\\+)\\s*(?:[\\w"]+\\.)?\\b${column}\\b`);
    const match = pattern.exec(parent.expression);
    if (match) return match[1] === '-' ? -1 : 1;
    // present but with no operator in front (the first operand, or after a parenthesis) means it is added
    if (new RegExp(`\\b${column}\\b`).test(parent.expression)) return 1;
  }
  return 0;
}

function expressionMentions(index: ModelIndex, metricId: string, expression: string): boolean {
  const metric = index.metrics.find((entry) => entry.id === metricId);
  if (!metric) return false;
  const columns = (metric.payload.columns ?? []).map((column) => column.replace(/^column\//, '').split('.').pop() ?? '');
  return columns.some((column) => column.length > 0 && new RegExp(`\\b${column}\\b`).test(expression));
}

function resolveMetric(index: ModelIndex, idOrName: string): { id: string } | null {
  const found = index.metrics.find((entry) => entry.id === idOrName || entry.payload.name === idOrName);
  return found ? { id: found.id } : null;
}

function collectPath(root: AttributionNode): AttributionNode[] {
  const path = [root];
  let cursor = root;
  while (cursor.children.length > 0) {
    cursor = cursor.children[0]!;
    path.push(cursor);
  }
  return path;
}

function pickSettings(options: AttributeOptions): Partial<typeof DEFAULTS> {
  return {
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.maxQueries !== undefined ? { maxQueries: options.maxQueries } : {}),
    ...(options.maxMs !== undefined ? { maxMs: options.maxMs } : {}),
    ...(options.pruneShare !== undefined ? { pruneShare: options.pruneShare } : {}),
    ...(options.expandShare !== undefined ? { expandShare: options.expandShare } : {}),
    ...(options.topK !== undefined ? { topK: options.topK } : {}),
  };
}

function refusal(index: ModelIndex, options: AttributeOptions, code: AgentRefusal['code'],
  message: string, hint?: string): AttributionResult {
  const empty: AttributionNode = {
    metric: options.metric, depth: 0, filters: [], previous: 0, current: 0, delta: 0,
    decomposition: 'none', drivers: [], sliceSets: [], unexplained: null, children: [], queries: 0,
  };
  void index;
  return {
    agent: 'attribution',
    metric: options.metric,
    period: { dimension: options.periodDimension ?? '', from: options.from, to: options.to },
    root: empty,
    path: [empty],
    explanation: `无法归因：${message}`,
    limits: ['拒绝比编造一个原因好'],
    confidence: { score: 0, warnings: [message] },
    cost: { queries: 0, naiveQueries: 0, rows: 0, ms: 0, iterations: 0 },
    refusals: [{ code, message, ...(hint ? { hint } : {}) }],
    evidence: { sql: [] },
  };
}
