/**
 * M6: the campaign agent - where to put the next yuan, and how to find out whether it worked.
 *
 * The agent is deliberately narrow, because campaign analytics is where confident nonsense is easiest:
 *
 * - **The 口径 comes from the model, not from here.** Spend and revenue are the semantic layer's metrics; if
 *   they are missing the agent refuses. It never guesses "revenue = clicks".
 * - **Average ROI is not used for decisions.** Cells are ranked by the *marginal* return from a curve fitted on
 *   that cell's own history, and if no cell shows curvature the agent refuses to recommend a reallocation.
 * - **One query for the grid.** The cell-by-period spend and revenue grid is two statements (one per metric)
 *   with a four-column GROUP BY, not a query per cell.
 * - **The output is falsifiable.** Every plan carries a holdout design and the arithmetic that says whether it
 *   can detect the effect; the narrative says the numbers are projections, not outcomes.
 */

import type { QueryRunner } from '../../../dataplane/src/sqlite.ts';
import type { AgentRefusal } from '../../../core/src/result.ts';
import {
  RenderError,
  indexModel,
  renderByDimensions,
  type ModelIndex,
} from '../../../semantic/src/sql.ts';
import type { MergedCandidate } from '../../../semantic/src/merge.ts';
import { fitResponse, type ResponseCurve, type SpendRevenuePoint } from './curve.ts';
import { InfeasibleAllocation, allocate, type AllocationResult } from './optimize.ts';
import { proposeHoldout, type HoldoutDesign } from './holdout.ts';
import { narrate } from './narrate.ts';

export interface CampaignOptions {
  index?: ModelIndex;
  candidates?: MergedCandidate[];
  run: QueryRunner;
  spendMetric?: string;
  revenueMetric?: string;
  regionDim?: string;
  industryDim?: string;
  channelDim?: string;
  periodDim?: string;
  /** Total budget for the coming period; defaults to the current period's spend. */
  budget?: number;
  /** Most a cell may move, as a fraction of its current spend. */
  maxChangePct?: number;
  minShare?: number;
  maxShare?: number;
  /** Which period's spend is "the current plan"; defaults to the latest period in the data. */
  currentPeriod?: string;
  /**
   * What the plan maximises. `revenue` (default) is a fixed-budget reallocation; `profit` may leave budget
   * unspent, which is what a stop-loss decision needs.
   */
  objective?: 'revenue' | 'profit';
  /** When true the budget is an upper bound rather than a total. */
  budgetIsCap?: boolean;
  horizonWeeks?: number;
  now?: string;
}

export interface CampaignCell {
  id: string;
  key: { region?: string; industry?: string; channel?: string };
  currentSpend: number;
  proposedSpend: number;
  delta: number;
  /** The cell's share of the total budget after the plan. */
  shareOfBudget: number;
  currentRoi: number;
  /** `dRevenue/dSpend` at the *current* spend: the number that should drive the decision. */
  marginalRoi: number;
  /** The same derivative at the proposed spend: the plan equalises these, subject to the bounds. */
  marginalRoiAfter: number;
  expectedRevenueDelta: number;
  curve: { kind: string; params: Record<string, number>; r2: number; points: number; saturation: number };
}

export interface CampaignResult {
  agent: 'campaign';
  window: { periods: number; first: string; last: string };
  budget: number;
  allocation: AllocationResult;
  cells: CampaignCell[];
  topMoves: { cell: string; delta: number; expectedRevenueDelta: number; marginalRoi: number; currentRoi: number }[];
  holdout: HoldoutDesign;
  explanation: string;
  limits: string[];
  confidence: { score: number; warnings: string[] };
  cost: { queries: number; cells: number; periods: number; ms: number };
  refusals: AgentRefusal[];
  evidence: { sql: string[] };
}

const DEFAULTS = {
  spendMetric: 'metric/spend',
  revenueMetric: 'metric/revenue',
  regionDim: 'dim/region',
  industryDim: 'dim/industry',
  channelDim: 'dim/channel',
  periodDim: 'dim/month',
  maxChangePct: 0.5,
  minShare: 0.005,
  maxShare: 0.35,
  horizonWeeks: 4,
  minPoints: 5,
  minCurvature: 0.98,
  minGainOverNoise: 1,
};

export function campaign(options: CampaignOptions): CampaignResult {
  const index = options.index ?? indexModel(options.candidates ?? []);
  const settings = {
    ...DEFAULTS,
    ...(options.spendMetric ? { spendMetric: options.spendMetric } : {}),
    ...(options.revenueMetric ? { revenueMetric: options.revenueMetric } : {}),
    ...(options.regionDim ? { regionDim: options.regionDim } : {}),
    ...(options.industryDim ? { industryDim: options.industryDim } : {}),
    ...(options.channelDim && options.channelDim !== '' ? { channelDim: options.channelDim } : {}),
    ...(options.periodDim ? { periodDim: options.periodDim } : {}),
    ...(options.maxChangePct !== undefined ? { maxChangePct: options.maxChangePct } : {}),
    ...(options.minShare !== undefined ? { minShare: options.minShare } : {}),
    ...(options.maxShare !== undefined ? { maxShare: options.maxShare } : {}),
    ...(options.horizonWeeks !== undefined ? { horizonWeeks: options.horizonWeeks } : {}),
  };
  const started = performance.now();
  const budgetCounter = { queries: 0, sql: [] as string[] };
  const runQuery = (sql: string) => {
    budgetCounter.queries++;
    budgetCounter.sql.push(sql);
    return options.run(sql);
  };

  // --- 1. the model has to have the 口径, or there is nothing to optimize
  const missing = [settings.spendMetric, settings.revenueMetric, settings.regionDim, settings.industryDim, settings.periodDim]
    .filter((id) => !index.metrics.some((entry) => entry.id === id) && !index.dimensions.some((entry) => entry.id === id));
  if (missing.length > 0) {
    return empty(options, index, budgetCounter, 'not-in-model',
      `the semantic model is missing ${missing.join(', ')}`,
      'model the spend/revenue metrics and the region/industry/period dimensions first (semantic build)');
  }

  const dimensions = [settings.periodDim, settings.regionDim, settings.industryDim,
    ...(settings.channelDim && index.dimensions.some((entry) => entry.id === settings.channelDim) ? [settings.channelDim] : [])];

  // --- 2. one grid per metric: period x region x industry x channel
  let spendGrid: { sql: string; rows: Record<string, unknown>[] };
  let revenueGrid: { sql: string; rows: Record<string, unknown>[] };
  try {
    const spendPlan = renderByDimensions(index, settings.spendMetric, dimensions);
    const revenuePlan = renderByDimensions(index, settings.revenueMetric, dimensions);
    spendGrid = { sql: spendPlan.sql, rows: runQuery(spendPlan.sql).rows };
    revenueGrid = { sql: revenuePlan.sql, rows: runQuery(revenuePlan.sql).rows };
  } catch (error) {
    if (error instanceof RenderError) {
      return empty(options, index, budgetCounter, 'not-in-model', error.message, 'add the missing relation or binding');
    }
    return empty(options, index, budgetCounter, 'unvalidated', (error as Error).message,
      'the grid query failed; check the model bindings against the warehouse');
  }

  // --- 3. pivot into cells
  const revenueByCellPeriod = new Map<string, number>();
  for (const row of revenueGrid.rows) {
    revenueByCellPeriod.set(rowKey(row, dimensions.length), Number(row.value ?? 0));
  }
  const cells = new Map<string, { key: { region?: string; industry?: string; channel?: string }; points: SpendRevenuePoint[] }>();
  const spendByCellPeriod = new Map<string, number>();
  const periods = new Set<string>();
  for (const row of spendGrid.rows) {
    const period = String(row.dim_0);
    periods.add(period);
    const key = cellKey(row);
    const cellId = keyId(key);
    const spend = Number(row.value ?? 0);
    const revenue = revenueByCellPeriod.get(rowKey(row, dimensions.length)) ?? 0;
    const cell = cells.get(cellId) ?? { key, points: [] };
    cell.points.push({ spend, revenue });
    cells.set(cellId, cell);
    spendByCellPeriod.set(`${cellId}|${period}`, spend);
  }
  const sortedPeriods = [...periods].sort();
  if (sortedPeriods.length === 0) {
    return empty(options, index, budgetCounter, 'unvalidated', 'the data has no periods to fit a response curve on',
      'check the period dimension and the warehouse window');
  }
  const currentPeriod = options.currentPeriod ?? sortedPeriods[sortedPeriods.length - 1]!;

  // --- 4. a curve per cell, and the current plan
  const usable: { id: string; key: { region?: string; industry?: string; channel?: string }; curve: ResponseCurve; currentSpend: number }[] = [];
  const skipped: string[] = [];
  const fits: number[] = [];
  for (const [id, cell] of cells) {
    const currentSpend = spendByCellPeriod.get(`${id}|${currentPeriod}`) ?? 0;
    if (cell.points.length < settings.minPoints || currentSpend <= 0) {
      skipped.push(id);
      continue;
    }
    try {
      const curve = fitResponse(cell.points, { at: currentSpend });
      usable.push({ id, key: cell.key, curve, currentSpend });
      fits.push(curve.saturation);
    } catch {
      skipped.push(id);
    }
  }

  if (usable.length < 3) {
    return empty(options, index, budgetCounter, 'unvalidated',
      `only ${usable.length} cell(s) have enough history for a response curve`,
      'widen the window or drop a dimension so each cell has at least 5 periods');
  }

  const saturated = fits.filter((value) => value < settings.minCurvature).length;
  if (saturated === 0) {
    return empty(options, index, budgetCounter, 'unvalidated',
      'no cell shows diminishing returns (marginal/average ≥ 0.98 everywhere): a reallocation cannot be justified from this data',
      'collect a wider spend range per cell, or do not reallocate on this evidence');
  }

  const budget = options.budget ?? usable.reduce((total, cell) => total + cell.currentSpend, 0);

  // --- 5. allocate
  let allocation: AllocationResult;
  try {
    allocation = allocate(
      usable.map((cell) => ({ id: cell.id, key: cell.key, currentSpend: cell.currentSpend, curve: cell.curve })),
      {
        budget,
        maxChangePct: settings.maxChangePct,
        minShare: settings.minShare,
        maxShare: settings.maxShare,
        objective: options.objective ?? 'revenue',
        budgetIsCap: options.budgetIsCap === true,
      },
    );
  } catch (error) {
    if (error instanceof InfeasibleAllocation) {
      return empty(options, index, budgetCounter, 'budget', error.message,
        `choose a budget within the per-cell bounds (±${(settings.maxChangePct * 100).toFixed(0)}%)`);
    }
    throw error;
  }

  // --- 6. the recommendation is only made when the gain clears the curves' own noise
  const noise = allocation.totals.noise;
  const objective = options.objective ?? 'revenue';
  // Under a profit objective the number that matters is revenue - spend, and it can be positive while revenue
  // falls: cutting a cell whose next yuan returns 0.3 keeps 0.7 yuan. Gating on revenue would refuse exactly the
  // recommendation a stop-loss question asks for.
  const primaryDelta = objective === 'profit'
    ? allocation.totals.expectedProfitDelta
    : allocation.totals.expectedRevenueDelta;
  if (primaryDelta <= noise * settings.minGainOverNoise || primaryDelta <= 0) {
    return empty(options, index, budgetCounter, 'unvalidated',
      `the projected ${objective} gain ${fmt(primaryDelta)} does not clear the curves' noise ${fmt(noise)}`,
      'no reallocation is recommended: the data cannot distinguish this plan from leaving the budget alone');
  }

  const cellsOut: CampaignCell[] = allocation.cells.map((cell) => {
    const source = usable.find((entry) => entry.id === cell.id);
    return {
      id: cell.id,
      key: cell.key as CampaignCell['key'],
      currentSpend: cell.currentSpend,
      proposedSpend: cell.proposedSpend,
      delta: cell.delta,
      shareOfBudget: cell.shareOfBudget,
      currentRoi: cell.currentRoi,
      marginalRoi: cell.marginalRoi,
      marginalRoiAfter: source ? roundMetric(source.curve.marginal(cell.proposedSpend)) : cell.marginalRoi,
      expectedRevenueDelta: cell.expectedRevenueDelta,
      curve: cell.curve,
    };
  });

  const holdout = proposeHoldout({
    candidates: cellsOut
      .filter((cell) => cell.delta > 0)
      .map((cell) => ({
        cell: cell.id,
        region: cell.key.region,
        industry: cell.key.industry,
        channel: cell.key.channel,
        delta: cell.delta,
        expectedRevenueDelta: cell.expectedRevenueDelta,
        noise: noiseFor(usable, cell.id),
      })),
    comparableCells: cellsOut.filter((cell) => cell.delta <= 0).length,
    horizonWeeks: settings.horizonWeeks,
    netBudgetDeltaRatio: allocation.totals.currentSpend === 0 ? 0
      : (allocation.totals.proposedSpend - allocation.totals.currentSpend) / allocation.totals.currentSpend,
  });

  const warnings: string[] = [];
  if (skipped.length > 0) warnings.push(`${skipped.length} cell(s) had too little history and were left out`);
  if (allocation.boundHit) warnings.push('a bound (max change or share) stopped the loop: the unconstrained optimum is further out');
  const medianR2 = median(cellsOut.map((cell) => cell.curve.r2));
  if (medianR2 < 0.8) warnings.push(`median curve r² is ${medianR2.toFixed(2)}: the projections are weak`);

  const result: CampaignResult = {
    agent: 'campaign',
    window: { periods: sortedPeriods.length, first: sortedPeriods[0]!, last: currentPeriod },
    budget,
    allocation,
    cells: cellsOut,
    topMoves: allocation.cells
      .filter((cell) => Math.abs(cell.delta) > 1e-6)
      .slice(0, 6)
      .map((cell) => ({
        cell: cell.id,
        delta: cell.delta,
        expectedRevenueDelta: cell.expectedRevenueDelta,
        marginalRoi: cell.marginalRoi,
        currentRoi: cell.currentRoi,
      })),
    holdout,
    explanation: '',
    limits: [],
    confidence: {
      score: Math.max(0.2, Math.min(0.95, medianR2 * 0.9 - (allocation.boundHit ? 0.05 : 0))),
      warnings,
    },
    cost: {
      queries: budgetCounter.queries,
      cells: cells.size,
      periods: sortedPeriods.length,
      ms: Math.round(performance.now() - started),
    },
    refusals: [],
    evidence: { sql: budgetCounter.sql },
  };

  result.explanation = narrate(result, objective);
  result.limits = [
    '收益是响应曲线的外推（模型预测），不是已实现的增量',
    `优化目标是 ${objective === 'profit' ? '利润（收入 − 花费，可不花满预算）' : '收入（预算不变，只做再分配）'}`,
    `建议幅度限制在每个 cell 当前预算的 ±${(settings.maxChangePct * 100).toFixed(0)}%，超出部分不受数据支持`,
    '曲线用该 cell 自身历史拟合；若外部环境（竞价、素材、人群）变化，曲线会失效',
    '没有做因果实验：先按 holdout 方案小规模验证，再全量执行',
  ];
  return result;
}

function roundMetric(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value;
}

function noiseFor(usable: { id: string; curve: ResponseCurve }[], id: string): number {
  return usable.find((cell) => cell.id === id)?.curve.rmse ?? 0;
}

/** `dim_0` is the period, so a cell is `dim_1..dim_3`. */
function cellKey(row: Record<string, unknown>): { region?: string; industry?: string; channel?: string } {
  const text = (value: unknown): string | undefined => (value === undefined || value === null ? undefined : String(value));
  return { region: text(row.dim_1), industry: text(row.dim_2), channel: text(row.dim_3) };
}

function keyId(key: { region?: string; industry?: string; channel?: string }): string {
  return [key.region ?? '-', key.industry ?? '-', key.channel ?? '-'].join(' / ');
}

function rowKey(row: Record<string, unknown>, dimensions: number): string {
  const values = Array.from({ length: dimensions }, (_, index) => String(row[`dim_${index}`] ?? ''));
  return values.join('|');
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

function empty(options: CampaignOptions, index: ModelIndex, counter: { queries: number; sql: string[] },
  code: AgentRefusal['code'], message: string, hint?: string): CampaignResult {
  void options;
  void index;
  return {
    agent: 'campaign',
    window: { periods: 0, first: '', last: '' },
    budget: 0,
    allocation: {
      budget: 0, cells: [], moves: [], iterations: 0, boundHit: false,
      totals: {
        currentSpend: 0, proposedSpend: 0, expectedRevenueCurrent: 0, expectedRevenueProposed: 0,
        expectedRevenueDelta: 0, expectedProfitCurrent: 0, expectedProfitProposed: 0, expectedProfitDelta: 0,
        improvementPct: 0, noise: 0,
      },
    },
    cells: [],
    topMoves: [],
    holdout: {
      design: 'geoholdout', treatment: 'none', control: 'none', horizonWeeks: 0, effectSize: 0, noise: 0,
      requiredUnitsPerArm: 0, availableUnits: 0, feasible: false, note: 'no plan',
    },
    explanation: `无法给出投放建议：${message}`,
    limits: ['拒绝比给出一个无法验证的建议好'],
    confidence: { score: 0, warnings: [message] },
    cost: { queries: counter.queries, cells: 0, periods: 0, ms: 0 },
    refusals: [{ code, message, ...(hint ? { hint } : {}) }],
    evidence: { sql: counter.sql },
  };
}
