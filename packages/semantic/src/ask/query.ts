/**
 * `translate` and `ask`: a {@link QuerySpec} becomes SQL, is checked, is executed, and comes back with its
 * provenance.
 *
 * The split is the product's promise:
 *
 * - **translate** never runs anything. It returns the SQL, the plan, and the SQL layer's findings (a scan, a
 *   non-sargable predicate) so a person can look before it executes.
 * - **ask** runs the same SQL and adds the numbers, the model revision, the row count and the limits. A
 *   refusal is a first-class answer: no metric, no sliceable dimension and no time column each come back with
 *   what was missing rather than with a plausible total.
 *
 * Both are shared by every sub-agent through the same renderer, so "the SQL an answer came from" is the SQL in
 * `provenance`, byte for byte - not a re-render that might differ.
 */

import type { QueryRunner } from '../../../dataplane/src/sqlite.ts';
import type { AgentRefusal } from '../../../core/src/result.ts';
import { RenderError, dimensionValueExpr, renderByDimension, renderCrossFact, renderTotal, type ModelIndex } from '../sql.ts';
import type { MergedCandidate } from '../merge.ts';
import { analyze, type Finding } from '../../../sqllayer/src/analyze.ts';
import { interpret, requestedGrain, type QuerySpec, type ValueContext } from './interpret.ts';

export interface SemanticPlan {
  spec: QuerySpec;
  sql: string[];
  /** The predicate the period became, so a reader can check the boundary (half-open, not BETWEEN). */
  filters: string[];
  findings: Finding[];
  modelRevision: number | null;
  metricDefinition: {
    id: string; expression: string; tables: string[]; description?: string;
    metricKind?: string; additive?: boolean; crossFact?: { numerator: string; denominator: string };
  };
  dimensions: { id: string; name: string; column?: string }[];
}

export interface TranslateRequest {
  question?: string;
  /** An explicit spec bypasses the interpreter (a client that already knows what it wants). */
  spec?: QuerySpec;
  index: ModelIndex;
  candidates?: MergedCandidate[];
  modelRevision?: number | null;
  now?: Date;
  /** When present, values in the question become filters (or a refusal). */
  values?: ValueContext;
}

export interface TranslateResult {
  plan: SemanticPlan | null;
  refusals: AgentRefusal[];
  notes: string[];
}

export function translate(request: TranslateRequest): TranslateResult {
  const interpreted = request.spec
    ? { spec: request.spec, refusals: [] as AgentRefusal[], notes: [] as string[] }
    : interpret(request.question ?? '', request.index, request.now, request.values);
  if (!interpreted.spec) return { plan: null, refusals: interpreted.refusals, notes: interpreted.notes };

  const spec = interpreted.spec;
  const metric = request.index.metrics.find((entry) => entry.id === spec.metric);
  if (!metric) {
    return { plan: null, refusals: [{ code: 'no-such-metric', message: `the model has no metric '${spec.metric}'` }], notes: [] };
  }

  const filters = periodFilters(request.index, spec);
  if (filters.refusal) return { plan: null, refusals: [filters.refusal], notes: interpreted.notes };

  const valueFilters = valuePredicates(request.index, spec, metric.payload.crossFact !== undefined);
  if (valueFilters.refusal) return { plan: null, refusals: [valueFilters.refusal], notes: interpreted.notes };

  try {
    const predicates = [...filters.predicates, ...valueFilters.predicates];
    const dimension = spec.dimensions[0];
    // A cross-fact ratio cannot take the generic period predicate: each side needs its own date column, which the
    // cross-fact renderer knows about and this one does not.
    const rendered = metric.payload.crossFact
      ? renderCrossFact(request.index, spec.metric, dimension ? [dimension] : [], {
        ...(spec.period ? { period: { from: spec.period.from, to: spec.period.to } } : {}),
      })
      : dimension
        ? renderByDimension(request.index, spec.metric, dimension, predicates)
        : renderTotal(request.index, spec.metric, predicates);
    const sql = spec.topN && dimension ? withTopN(rendered.sql, spec.topN, spec.descending) : rendered.sql;
    return {
      plan: {
        spec,
        sql: [sql],
        filters: predicates,
        findings: analyze(sql, { catalog: undefined }),
        modelRevision: request.modelRevision ?? null,
        metricDefinition: {
          id: metric.id,
          expression: metric.payload.expression,
          tables: metric.payload.tables,
          metricKind: metric.payload.metricKind,
          ...(metric.payload.additive === undefined ? {} : { additive: metric.payload.additive }),
          ...(metric.payload.crossFact ? { crossFact: metric.payload.crossFact } : {}),
          ...(metric.payload.description ? { description: metric.payload.description } : {}),
        },
        dimensions: spec.dimensions.map((id) => {
          const entry = request.index.dimensions.find((candidate) => candidate.id === id);
          return { id, name: entry?.payload.name ?? id, ...(entry?.payload.column ? { column: entry.payload.column } : {}) };
        }),
      },
      refusals: [],
      notes: interpreted.notes,
    };
  } catch (error) {
    if (error instanceof RenderError) {
      return { plan: null, refusals: [{ code: 'not-in-model', message: error.message, hint: '补上 references 关系或维度绑定' }], notes: interpreted.notes };
    }
    throw error;
  }
}

/**
 * Turns explicit value filters into SQL predicates.
 *
 * A filter is only accepted when it names a dimension the metric can actually be sliced by and a dimension whose
 * column survives the metric's own tables; anything else is a refusal, because "filter by region" on a metric with no
 * region is the kind of quiet no-op that makes a report lie. Cross-fact metrics refuse filters outright: their two
 * sides each have their own date column and their own tables, and a single predicate cannot be aimed at both.
 */
function valuePredicates(index: ModelIndex, spec: QuerySpec, isCrossFact: boolean): {
  predicates: string[];
  refusal?: AgentRefusal;
} {
  const requested = spec.filters ?? [];
  if (requested.length === 0) return { predicates: [] };
  if (isCrossFact) {
    return {
      predicates: [],
      refusal: {
        code: 'not-in-model',
        message: '跨事实指标不接受值过滤：两侧各用自己的日期列与表，一条谓词无法同时指向两边',
        hint: '先在单事实指标上过滤，或把过滤条件写进跨事实的分子/分母定义',
      },
    };
  }
  const sliceable = new Set(index.groupedBy.filter((edge) => edge.from === spec.metric).map((edge) => edge.to));
  const predicates: string[] = [];
  for (const filter of requested) {
    const dimension = index.dimensions.find((entry) => entry.id === filter.dimension)
      ?? index.dimensions.find((entry) => entry.payload.name === filter.dimension);
    if (!dimension) {
      return {
        predicates: [],
        refusal: {
          code: 'no-such-dimension',
          message: `过滤引用了不存在的维度「${filter.dimension}」`,
          hint: `可用维度：${[...sliceable].join('、') || '（无）'}`,
          candidates: [...sliceable],
        },
      };
    }
    if (!sliceable.has(dimension.id)) {
      return {
        predicates: [],
        refusal: {
          code: 'no-such-dimension',
          message: `「${dimension.payload.name}」不能用来切分该指标`,
          hint: `可用维度：${[...sliceable].join('、')}`,
          candidates: [...sliceable],
        },
      };
    }
    predicates.push(`${dimensionValueExpr(dimension.payload)} = '${String(filter.value).replace(/'/g, "''")}'`);
  }
  return { predicates };
}

export interface AskResult {
  answer: {
    rows: { value: unknown; measure: number }[];
    total: number;
    /** True when a top-N cut the rows: the total is then the sum of the returned rows, not of the period. */
    partial?: boolean;
    compared?: { period: string; total: number; delta: number; deltaPct: number };
  };
  plan: SemanticPlan;
  provenance: Record<string, unknown>;
  confidence: { score: number; warnings: string[] };
  limits: string[];
  refusals: AgentRefusal[];
  cost: { queries: number; rows: number; ms: number };
}

export function ask(request: TranslateRequest & { run: QueryRunner }): AskResult | { refusals: AgentRefusal[] } {
  const translated = translate(request);
  if (!translated.plan) return { refusals: translated.refusals };

  const plan = translated.plan;
  const started = performance.now();
  let queries = 0;
  let rows = 0;
  try {
    const result = request.run(plan.sql[0]!);
    queries++;
    rows += result.rowCount;
    const dimension = plan.spec.dimensions[0];
    const parsed = dimension
      ? result.rows.map((row) => ({ value: row.dim_value, measure: Number(row.value ?? 0) }))
      : [{ value: null, measure: Number(result.rows[0]?.value ?? 0) }];

    // A ratio's slices do not add up: the total is the metric's own whole-window value, computed by the same
    // renderer with the dimensions removed, and the answer says so instead of presenting a meaningless sum.
    const nonAdditive = plan.metricDefinition.metricKind === 'ratio' || plan.metricDefinition.additive === false;
    let total = parsed.reduce((sum, row) => sum + row.measure, 0);
    let totalIsSum = true;
    if (dimension && nonAdditive) {
      const totals = translate({ ...request, spec: { ...plan.spec, dimensions: [], topN: undefined } });
      if (totals.plan) {
        const totalsRow = request.run(totals.plan.sql[0]);
        queries++;
        rows += totalsRow.rowCount;
        total = Number(totalsRow.rows[0]?.value ?? NaN);
        totalIsSum = false;
      }
    }

    // a comparison runs the previous window through the same renderer, so the only difference is the filter
    let compared: AskResult['answer']['compared'];
    const warnings: string[] = [];
    if (plan.spec.compare && plan.spec.period) {
      const previous = shiftPeriod(plan.spec.period, plan.spec.compare);
      const shifted = translate({ ...request, spec: { ...plan.spec, period: previous, compare: undefined } });
      if (shifted.plan) {
        const previousResult = request.run(shifted.plan.sql[0]!);
        queries++;
        rows += previousResult.rowCount;
        const previousTotal = dimension
          ? previousResult.rows.reduce((sum, row) => sum + Number(row.value ?? 0), 0)
          : Number(previousResult.rows[0]?.value ?? 0);
        compared = {
          period: `${previous.from} ~ ${previous.to}`,
          total: previousTotal,
          delta: total - previousTotal,
          deltaPct: previousTotal === 0 ? Number.NaN : (total - previousTotal) / previousTotal,
        };
        if (previousTotal === 0) warnings.push('the comparison window has no data: the percentage change is undefined');
      }
    }

    return {
      answer: {
        rows: parsed,
        total,
        ...(plan.spec.topN && dimension ? { partial: true } : {}),
        ...(compared ? { compared } : {}),
      },
      plan,
      provenance: {
        semanticModel: { revision: plan.modelRevision },
        metric: plan.metricDefinition.id,
        metricExpression: plan.metricDefinition.expression,
        tables: plan.metricDefinition.tables,
        dimensions: plan.dimensions,
        filters: plan.filters,
        period: plan.spec.period ?? null,
        sql: plan.sql[0],
        executedOn: 'warehouse',
        rowCount: parsed.length,
      },
      confidence: {
        score: Math.max(0.3, 0.9 - plan.findings.filter((finding) => finding.severity === 'high').length * 0.2),
        warnings: [
          ...warnings,
          ...plan.findings.filter((finding) => finding.rule === 'P02').map((finding) => `性能：${finding.message}`),
        ],
      },
      limits: [
        '这是语义模型上的确定性查询：口径来自模型，不是推断',
        ...(totalIsSum ? [] : [`各行不可加：total 是 ${plan.metricDefinition.id} 在整个窗口上的整体口径，不是各行之和`]),
        ...(plan.spec.compare ? ['对比窗口按同一渲染器生成，过滤条件不同、口径相同'] : []),
        ...(plan.spec.topN && dimension ? [`只返回前 ${plan.spec.topN} 项：total 是这些项的和，不是全量合计`] : []),
      ],
      refusals: [],
      cost: { queries, rows, ms: Math.round(performance.now() - started) },
    };
  } catch (error) {
    return {
      refusals: [{
        code: 'unvalidated',
        message: `the generated SQL does not run: ${(error as Error).message}`,
        hint: plan.sql[0],
      }],
    };
  }
}

/** `dim/month`-style dims carry an expression; the period predicate uses the raw column so an index can seek. */
function periodFilters(index: ModelIndex, spec: QuerySpec): { predicates: string[]; refusal?: AgentRefusal } {
  if (!spec.period) return { predicates: [] };
  const timeDimension = index.dimensions.find((dimension) =>
    dimension.payload.level === 'month'
    && (index.groupedBy.some((edge) => edge.to === dimension.id && edge.from === spec.metric)));
  if (!timeDimension?.payload.column) return { predicates: [] };
  const column = dimensionValueExpr({ column: timeDimension.payload.column });
  return {
    predicates: [`${column} >= '${spec.period.from}' AND ${column} < '${spec.period.to}'`],
  };
}

function withTopN(sql: string, topN: number, descending: boolean): string {
  const direction = descending ? 'DESC' : 'ASC';
  // Order by the *measure*, not by the dimension: the renderer's own `ORDER BY 1` sorts the slice labels
  // alphabetically, so keeping it would return the first two regions by name instead of the top two by value.
  const withoutOrder = sql.replace(/\border\s+by\s+[\s\S]*?$/i, '').replace(/;\s*$/, '').trimEnd();
  return `${withoutOrder} ORDER BY value ${direction} LIMIT ${topN}`;
}

function shiftPeriod(period: NonNullable<QuerySpec['period']>, compare: 'yoy' | 'mom'): NonNullable<QuerySpec['period']> {
  const shiftDays = compare === 'yoy' ? -365 : daysIn(period);
  return {
    ...period,
    from: shift(period.from, shiftDays),
    to: shift(period.to, shiftDays),
    said: `${period.said}（对比 ${compare === 'yoy' ? '去年同期' : '上一期'}）`,
  };
}

function daysIn(period: NonNullable<QuerySpec['period']>): number {
  const from = Date.parse(`${normalize(period.from)}T00:00:00Z`);
  const to = Date.parse(`${normalize(period.to)}T00:00:00Z`);
  return Math.max(1, Math.round((to - from) / 86_400_000));
}

function normalize(label: string): string {
  if (/^\d{4}$/.test(label)) return `${label}-01-01`;
  if (/^\d{4}-\d{2}$/.test(label)) return `${label}-01`;
  return label;
}

function shift(date: string, days: number): string {
  const parsed = new Date(`${normalize(date)}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export { requestedGrain };
export type { QuerySpec } from './interpret.ts';
