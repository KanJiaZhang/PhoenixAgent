/**
 * The interpreter: a question in, a query spec out - deterministically, from the model's own vocabulary.
 *
 * This is the piece that decides whether the product is trustworthy. A language model would parse more
 * questions and would also, occasionally, decide that "各渠道营收" means "总营收" and hand back a correct number
 * to a different question. That failure mode is the one this file refuses to have:
 *
 * - **Vocabulary comes from the model.** Metric names and aliases, dimension names and aliases: nothing else is
 *   a metric. A word the model does not know is not quietly ignored.
 * - **A breakdown word with no matching dimension is a refusal.** 「各渠道」「按大区」「分别」 ask for a
 *   decomposition; answering with a total is a wrong answer that looks right. The base learned this the
 *   expensive way (its DATA-AGENT.md §10 records the same bug), and the rule is kept here.
 * - **An ambiguous name is a refusal, not a guess.** Two metrics whose aliases match equally well are listed,
 *   and the caller chooses.
 * - **Nothing is inferred about time.** A year with no date column in the model is a refusal with the reason,
 *   not a filter that silently matches nothing.
 *
 * The output, {@link QuerySpec}, is the shared currency: `translate` renders it, `ask` executes it, and the
 * provenance in the answer names it.
 */

import type { AgentRefusal } from '../../../core/src/result.ts';
import type { ModelIndex } from '../sql.ts';
import { tableOfColumnId } from '../sql.ts';

export type PeriodGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface PeriodSpec {
  /** Inclusive start label, `YYYY-MM-DD` for a day, `YYYY-MM` for a month, `YYYY` for a year. */
  from: string;
  /** Exclusive end label. */
  to: string;
  grain: PeriodGrain;
  /** What the question said, for the provenance. */
  said: string;
}

export interface QuerySpec {
  metric: string;
  dimensions: string[];
  /**
   * Value filters, e.g. `region = '华东'`.
   *
   * Explicit only: the interpreter does not parse values out of a question yet (a value vocabulary is a model
   * question, and guessing one from a 5-row sample is how "华东" becomes "华北"). A client that knows the slice
   * passes it; the canary release uses exactly this to scope traffic to one slice.
   */
  filters?: { dimension: string; value: string }[];
  period?: PeriodSpec;
  /** Compare with the same period one year (yoy) or one period (mom) earlier. */
  compare?: 'yoy' | 'mom';
  topN?: number;
  descending: boolean;
  /** The words that were matched, so the answer can explain itself. */
  matched: string[];
}

export interface Interpretation {
  spec: QuerySpec | null;
  refusals: AgentRefusal[];
  notes: string[];
}

/**
 * Surface words that are not in the model but are how people actually ask.
 *
 * This table is product vocabulary, kept short and explicit on purpose: every entry maps a word a user types to
 * a metric *name* the model must already have (a synonym that resolves to nothing is ignored, never invented).
 * A model that already carries the word through its aliases does not need an entry here - and a word that is
 * missing shows up as a refusal listing the vocabulary, which is how the table stays honest.
 */
const METRIC_SYNONYMS: { metric: string; words: string[] }[] = [
  { metric: 'spend', words: ['花费', '消耗', '投放成本', '投入'] },
  { metric: 'revenue', words: ['收入', '营收', '销售额', '流水', '归因收入'] },
  { metric: 'gmv', words: ['成交额', '成交总额', '交易额'] },
  { metric: 'new_customers', words: ['新客', '新客数'] },
  { metric: 'conversions', words: ['转化数', '转化量', '转化'] },
  { metric: 'conversion_rate', words: ['转化率'] },
  { metric: 'clicks', words: ['点击', '点击量', '点击次数'] },
  { metric: 'impressions', words: ['曝光', '曝光次数'] },
  { metric: 'roi', words: ['投入产出比', '回报率'] },
  { metric: 'cpa', words: ['转化成本', '获客成本'] },
  { metric: 'paid_orders', words: ['订单数', '支付订单数'] },
  { metric: 'refunded_amount', words: ['退款'] },
  { metric: 'paid_amount', words: ['支付金额', '已支付金额'] },
];

const DIM_SYNONYMS: { dimension: string; words: string[] }[] = [
  { dimension: 'region', words: ['大区', '地区', '区域'] },
  { dimension: 'industry', words: ['行业', '品类'] },
  { dimension: 'channel', words: ['渠道', '媒体'] },
  { dimension: 'month', words: ['月份', '按月', '月度'] },
  { dimension: 'year', words: ['年度', '按年'] },
  { dimension: 'campaign', words: ['投放计划', '计划'] },
];

const BREAKDOWN = /各(?:个)?|按|每个|分别|分(?!析)|by\s|breakdown\s|per\s|每个/i;
const TOP_N = /(?:前|top\s*|最高的?\s*)(\d{1,3})/i;
const YEAR = /(?:^|[^\d])((?:19|20)\d{2})\s*年?/;
const YEAR_MONTH = /((?:19|20)\d{2})\s*[-年/]\s*(\d{1,2})\s*月?/;
const MONTH_ONLY = /(\d{1,2})\s*月/;
const QUARTER = /(?:q|第)([1-4])(?:季度)?/i;
const RELATIVE = /(今年|去年|前年|本月|这个月|上月|上个月|本季度|上个季度)/;
const GRAIN = /(?:按|每)(天|日|周|月|季度|年)|(天级|周级|月级|季度|年度|日粒度|月粒度)/;
const COMPARE = /(同比|环比|和去年比|比去年|跟上月比)/;

/** Interprets a question against one metric's vocabulary. */
export function interpret(question: string, index: ModelIndex, now = new Date()): Interpretation {
  const text = question.trim();
  const refusals: AgentRefusal[] = [];
  const notes: string[] = [];
  const matched: string[] = [];

  const metricMatch = matchMetric(text, index);
  if (metricMatch.refusal) return { spec: null, refusals: [metricMatch.refusal], notes };
  const metric = metricMatch.metric!;
  if (metric.status === 'needs_review') {
    // the review queue is not decoration: a metric nobody has accepted is not served
    return {
      spec: null,
      refusals: [{
        code: 'unvalidated',
        message: `${metric.payload.name} 还在审查队列里（未采纳），不能直接出数`,
        hint: '先在后端采纳该候选（POST /v1/semantic/review {action:"accept"}），或补上它的 ETL 定义',
      }],
      notes,
    };
  }
  matched.push(metric.payload.name);

  const sliceable = index.groupedBy.filter((edge) => edge.from === metric.id).map((edge) => edge.to);
  const dimensionMatch = matchDimension(text, index, sliceable);
  const dimensions: string[] = [];
  if (dimensionMatch.dimension) {
    dimensions.push(dimensionMatch.dimension.id);
    matched.push(dimensionMatch.dimension.payload.name);
  } else if (dimensionMatch.ambiguous) {
    refusals.push({
      code: 'ambiguous',
      message: `「${dimensionMatch.ambiguous.join('」「')}」都能匹配这个问题的维度`,
      hint: '请指明其中一个',
      candidates: dimensionMatch.ambiguous,
    });
    return { spec: null, refusals, notes };
  } else if (BREAKDOWN.test(text) && !/分析|解释/.test(text)) {
    // the rule the base had to learn: a breakdown word with no dimension is a refusal, never a total
    refusals.push({
      code: 'no-such-dimension',
      message: `问题要求分解（${text.match(BREAKDOWN)?.[0] ?? ''}），但语义模型里没有匹配的、能被 ${metric.payload.name} 切片的维度`,
      hint: `可用维度：${sliceable.map((id) => index.dimensions.find((dimension) => dimension.id === id)?.payload.name ?? id).join('、') || '（无）'}`,
      candidates: sliceable,
    });
    return { spec: null, refusals, notes };
  }

  const period = parsePeriod(text, now);
  if (period.said) matched.push(period.said);
  if (period.refusal) {
    refusals.push(period.refusal);
    return { spec: null, refusals, notes };
  }

  // A cross-fact metric has no single time dimension: each side is filtered through its own date column by the
  // cross-fact renderer. So the check moves to the renderer, which refuses per side and says which one.
  if (period.spec && !metric.payload.crossFact) {
    const timeDimension = findTimeDimension(index, metric.id, sliceable);
    if (!timeDimension) {
      refusals.push({
        code: 'not-in-model',
        message: `${metric.payload.name} 没有时间维度，无法按「${period.spec.said}」过滤`,
        hint: '给指标的事实表补一个日期维度（目录会从 DATE 列自动生成月/季/年）',
      });
      return { spec: null, refusals, notes };
    }
    const table = tableOfColumnId(timeDimension.payload.column ?? '');
    if (!(metric.payload.tables ?? []).includes(table)) {
      refusals.push({
        code: 'not-in-model',
        message: `时间维度 ${timeDimension.id} 绑定的列在 ${table}，而 ${metric.payload.name} 来自 ${(metric.payload.tables ?? []).join('/')}`,
        hint: '时间维度必须和指标在同一张事实表上',
      });
      return { spec: null, refusals, notes };
    }
  }

  const topMatch = TOP_N.exec(text);
  const compare = COMPARE.test(text) ? (/环比|跟上月比/.test(text) ? 'mom' : 'yoy') : undefined;

  return {
    spec: {
      metric: metric.id,
      dimensions,
      ...(period.spec ? { period: period.spec } : {}),
      ...(compare ? { compare } : {}),
      ...(topMatch ? { topN: Number(topMatch[1]) } : {}),
      descending: !/最低|最少|最小的?/.test(text),
      matched,
    },
    refusals: [],
    notes,
  };
}

function matchMetric(text: string, index: ModelIndex): { metric?: ModelIndex['metrics'][number]; refusal?: AgentRefusal } {
  const candidates: { metric: ModelIndex['metrics'][number]; term: string; length: number }[] = [];
  for (const metric of index.metrics) {
    if (!metric.payload.expression) continue;
    const synonyms = METRIC_SYNONYMS.find((entry) => entry.metric === metric.payload.name)?.words ?? [];
    const terms = [metric.payload.name, ...(metric.payload.alias ?? []), ...synonyms]
      .filter((term) => typeof term === 'string' && term.length >= 2);
    for (const term of terms) {
      if (text.toLowerCase().includes(term.toLowerCase())) candidates.push({ metric, term, length: term.length });
    }
  }
  if (candidates.length === 0) {
    return {
      refusal: {
        code: 'no-such-metric',
        message: '问题里没有语义模型认识的指标',
        hint: `可用指标：${index.metrics.map((metric) => metric.payload.name).join('、')}`,
        candidates: index.metrics.map((metric) => metric.id),
      },
    };
  }
  // the longest term wins ("投放花费" over "花费"); a tie between two metrics is a refusal
  const longest = Math.max(...candidates.map((candidate) => candidate.length));
  const best = candidates.filter((candidate) => candidate.length === longest);
  const unique = [...new Map(best.map((candidate) => [candidate.metric.id, candidate])).values()];
  if (unique.length > 1) {
    return {
      refusal: {
        code: 'ambiguous',
        message: `「${best[0]!.term}」同时匹配多个指标：${unique.map((candidate) => candidate.metric.payload.name).join('、')}`,
        hint: '请用更具体的指标名',
        candidates: unique.map((candidate) => candidate.metric.id),
      },
    };
  }
  return { metric: unique[0]!.metric };
}

function matchDimension(text: string, index: ModelIndex, sliceable: string[]): {
  dimension?: ModelIndex['dimensions'][number];
  ambiguous?: string[];
} {
  const matches: { dimension: ModelIndex['dimensions'][number]; length: number }[] = [];
  for (const id of sliceable) {
    const dimension = index.dimensions.find((entry) => entry.id === id);
    if (!dimension) continue;
    const synonyms = DIM_SYNONYMS.find((entry) => entry.dimension === dimension.payload.name)?.words ?? [];
    const terms = [dimension.payload.name, ...(dimension.payload.alias ?? []), ...synonyms]
      .filter((term) => typeof term === 'string' && term.length >= 2);
    for (const term of terms) {
      if (text.toLowerCase().includes(term.toLowerCase())) matches.push({ dimension, length: term.length });
    }
  }
  if (matches.length === 0) return {};
  const longest = Math.max(...matches.map((match) => match.length));
  const best = matches.filter((match) => match.length === longest);
  const unique = [...new Map(best.map((match) => [match.dimension.id, match])).values()];
  if (unique.length > 1) return { ambiguous: unique.map((match) => match.dimension.id) };
  return { dimension: unique[0]!.dimension };
}

function findTimeDimension(index: ModelIndex, metricId: string, sliceable: string[]) {
  const byLevel = sliceable
    .map((id) => index.dimensions.find((dimension) => dimension.id === id))
    .filter((dimension): dimension is NonNullable<typeof dimension> => dimension !== undefined)
    .find((dimension) => dimension.payload.level !== undefined);
  if (byLevel) return byLevel;
  return sliceable
    .map((id) => index.dimensions.find((dimension) => dimension.id === id))
    .find((dimension) => dimension !== undefined && /DATE|TIMESTAMP/i.test(dimension.payload.dataType ?? ''));
}

function parsePeriod(text: string, now: Date): { spec?: PeriodSpec; said?: string; refusal?: AgentRefusal } {
  const yearMonth = YEAR_MONTH.exec(text);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    if (month < 1 || month > 12) {
      return { refusal: { code: 'out-of-scope', message: `「${yearMonth[0]}」不是一个月份`, hint: '月份应在 1..12' } };
    }
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    return { spec: { from: start, to: next, grain: 'month', said: yearMonth[0] }, said: yearMonth[0] };
  }
  const year = YEAR.exec(text);
  if (year) {
    const value = Number(year[1]);
    return {
      spec: { from: `${value}-01-01`, to: `${value + 1}-01-01`, grain: 'year', said: `${value}年` },
      said: `${value}年`,
    };
  }
  const quarter = QUARTER.exec(text);
  if (quarter) {
    const currentYear = now.getUTCFullYear();
    const q = Number(quarter[1]);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 3;
    return {
      spec: {
        from: `${currentYear}-${String(startMonth).padStart(2, '0')}-01`,
        to: endMonth > 12 ? `${currentYear + 1}-01-01` : `${currentYear}-${String(endMonth).padStart(2, '0')}-01`,
        grain: 'quarter',
        said: `Q${q}`,
      },
      said: `Q${q}`,
    };
  }
  const relative = RELATIVE.exec(text);
  if (relative) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    switch (relative[1]) {
      case '今年': return { spec: { from: `${year}-01-01`, to: `${year + 1}-01-01`, grain: 'year', said: '今年' }, said: '今年' };
      case '去年': return { spec: { from: `${year - 1}-01-01`, to: `${year}-01-01`, grain: 'year', said: '去年' }, said: '去年' };
      case '前年': return { spec: { from: `${year - 2}-01-01`, to: `${year - 1}-01-01`, grain: 'year', said: '前年' }, said: '前年' };
      case '本月': case '这个月': return { spec: monthWindow(year, month, '本月'), said: '本月' };
      case '上月': case '上个月': {
        const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
        return { spec: monthWindow(previous.year, previous.month, '上月'), said: '上月' };
      }
      default: break;
    }
  }
  const monthOnly = MONTH_ONLY.exec(text);
  if (monthOnly && !YEAR.test(text)) {
    const month = Number(monthOnly[1]);
    if (month >= 1 && month <= 12) {
      const year = month <= now.getUTCMonth() + 1 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
      return { spec: monthWindow(year, month, `${month}月`), said: `${month}月` };
    }
  }
  return {};
}

function monthWindow(year: number, month: number, said: string): PeriodSpec {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { from: start, to: next, grain: 'month', said };
}

/** The grain the question asked for, if any (a dimension is chosen by name, so this is a note for the plan). */
export function requestedGrain(text: string): PeriodGrain | undefined {
  const match = GRAIN.exec(text);
  if (!match) return undefined;
  const word = match[1] ?? match[2] ?? '';
  if (/天|日/.test(word)) return 'day';
  if (/周/.test(word)) return 'week';
  if (/季/.test(word)) return 'quarter';
  if (/年/.test(word)) return 'year';
  return 'month';
}
