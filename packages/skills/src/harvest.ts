/**
 * Where tips come from: runs that already happened, with numbers attached.
 *
 * Three harvesters, and each one inherits its evidence from the thing that produced it rather than inventing
 * a sentence:
 *
 * - **From an M3 plan**: a rewrite that was measured (row counts equal, plan changed) becomes a tip whose
 *   evidence is that measurement. The tip cannot claim more than the plan proved.
 * - **From a semantic report**: a probe that failed or came back weak becomes a `check` tip - "when the grain
 *   probe fails, do not trust a sum on this table" is knowledge, and the injected build's failures are exactly
 *   where it comes from.
 * - **By hand**: a person may write one, and must attach evidence (a review id, a probe, a run). The store
 *   refuses it otherwise, so "by hand" does not mean "unfounded".
 *
 * Deduplication is by {@link SkillStore.idFor}: the same scope, rule and statement is the same tip, so the
 * second time a shape is seen it *confirms* the tip instead of adding a near-duplicate. That is what makes
 * "two independent runs" a fact about the log rather than a claim in a document.
 */

import { SkillStore, runId, type Tip, type TipEvidence } from './types.ts';
import type { PlanResult } from '../../sqllayer/src/steps.ts';
import type { QualityReport, ProbeResult } from '../../contracts/src/index.ts';
import type { AttributionResult } from '../../agents/attribution/src/loop.ts';
import type { CampaignResult } from '../../agents/campaign/src/agent.ts';
import type { RiskResult } from '../../agents/risk/src/agent.ts';

export interface HarvestContext {
  actor?: string;
  dialect?: string;
  now?: string;
}

/** The shape family a rule belongs to; it is what the scope filters on. */
export function shapeOf(rule: string): string {
  switch (rule) {
    case 'P01': return 'projection-star';
    case 'P02': return 'missing-time-filter';
    case 'P03': return 'date-prefix';
    case 'P04': return 'or-split';
    case 'P06': return 'cartesian';
    case 'P13': return 'unbounded';
    default: return rule.toLowerCase();
  }
}

/** One tip per result-preserving rewrite in a plan, with the plan's own measurement as evidence. */
export function harvestFromPlan(store: SkillStore, plan: PlanResult, context: HarvestContext = {}): Tip[] {
  const dialect = context.dialect ?? 'sqlite';
  const table = firstTable(plan.original);
  const tips: Tip[] = [];

  for (const step of plan.steps) {
    if (step.kind !== 'rewrite') continue;
    const id = runId(plan.original, step.rule, dialect);
    const metrics: Record<string, number> = {};
    if (plan.before && plan.after) {
      metrics.rowsBefore = plan.before.rows;
      metrics.rowsAfter = plan.after.rows;
      metrics.durationBeforeMs = plan.before.durationMs;
      metrics.durationAfterMs = plan.after.durationMs;
      metrics.fullScansBefore = plan.before.fullScans.length;
      metrics.fullScansAfter = plan.after.fullScans.length;
    }
    const evidence: TipEvidence = {
      runId: id,
      kind: 'plan',
      detail: `plan ${plan.id}: ${step.rule} on ${dialect}`
        + (plan.comparison ? ` (${plan.comparison.changed.join('; ')})` : ' (no plan change measured)'),
      before: step.sqlBefore,
      after: step.sqlAfter,
      metrics,
    };
    tips.push(store.harvest({
      scope: { agent: 'sqllayer', dialect, shape: shapeOf(step.rule), ...(table ? { table } : {}) },
      kind: 'rewrite',
      statement: `${step.rule} ${shapeOf(step.rule)}: ${step.rationale}`,
      rationale: step.rationale,
      applies: { rule: step.rule },
      evidence: [evidence],
      confidence: plan.comparison?.improved ? 0.8 : 0.6,
      createdBy: context.actor ?? 'agent',
      now: context.now,
    }));
  }
  // A finding without a rewrite is still a lesson: "this shape scans" is worth remembering even when there is
  // no safe rewrite for it. Those become `check` tips, with the plan that showed it as evidence.
  const covered = new Set(plan.steps.filter((step) => step.kind === 'rewrite').map((step) => step.rule));
  for (const finding of plan.findings) {
    if (covered.has(finding.rule)) continue;
    const id = runId(plan.original, finding.rule, dialect, 'finding');
    tips.push(store.harvest({
      scope: { agent: 'sqllayer', dialect, shape: shapeOf(finding.rule), ...(table ? { table } : {}) },
      kind: 'check',
      statement: `${finding.rule} ${shapeOf(finding.rule)}: ${finding.message}`,
      rationale: finding.suggestion ?? finding.message,
      applies: { rule: finding.rule },
      evidence: [{
        runId: id,
        kind: 'plan',
        detail: `plan ${plan.id}: ${finding.rule} fired on ${dialect} — ${finding.message}`,
        before: plan.original,
        metrics: plan.before ? { rowsBefore: plan.before.rows, fullScans: plan.before.fullScans.length } : {},
      }],
      confidence: 0.6,
      createdBy: context.actor ?? 'agent',
      now: context.now,
    }));
  }

  return tips;
}

/**
 * One `check` tip per failed or weak probe in a report.
 *
 * The injected build is the interesting one: it contains a wrong FK, a typo'd expression and a dead 口径
 * literal, and each of those is a lesson that generalises. The tip records the probe and the target, so the
 * advice can say "this exact thing went wrong here".
 */
export function harvestFromProbes(store: SkillStore, report: QualityReport, context: HarvestContext = {}): Tip[] {
  const tips: Tip[] = [];
  for (const probe of report.probes) {
    if (probe.status !== 'fail' && probe.status !== 'weak') continue;
    const evidence: TipEvidence = {
      runId: runId(report.graph, probe.id, String(report.modelVersion)),
      kind: 'probe',
      detail: `${probe.probe} ${probe.status} on ${probe.target}: ${probe.detail}`,
      ...(probe.sql ? { before: probe.sql } : {}),
      metrics: {
        ...(probe.value !== undefined ? { value: probe.value } : {}),
        ...(probe.threshold !== undefined ? { threshold: probe.threshold } : {}),
      },
    };
    tips.push(store.harvest({
      scope: { agent: 'semantic', shape: probe.probe },
      kind: 'check',
      statement: checkStatement(probe),
      rationale: probe.detail,
      applies: { keywords: keywordHints(probe) },
      evidence: [evidence],
      confidence: 0.7,
      createdBy: context.actor ?? 'agent',
      now: context.now,
    }));
  }
  return tips;
}

function checkStatement(probe: ProbeResult): string {
  switch (probe.probe) {
    case 'grain':
      return `grain: ${probe.target} 的声明粒度在数据里不唯一，任何落在这张表上的求和都不可信，先修粒度再出数`;
    case 'enum':
      return `enum: 口径里的字面量在数据里一行都匹配不到（${probe.detail}），指标会恒为 0，先核对取值再发布`;
    case 'references':
      return `references: ${probe.target} 的 join 命中率只有 ${probe.value === undefined ? '未知' : (probe.value * 100).toFixed(2)}%，不要按这个关系做切片`;
    case 'groupedBy':
      return `groupedBy: ${probe.target} 的切片加总不等于总量，这个维度不能用于分解，归因时要换成可加维度`;
    case 'formula':
      return `formula: ${probe.target} 的比率恒等式不成立，分子分母的口径不一致`;
    default:
      return `existence: ${probe.target} 不可执行（${probe.detail}），不要基于它下结论`;
  }
}

function keywordHints(probe: ProbeResult): string[] {
  switch (probe.probe) {
    case 'enum':
      return ['status', '='];
    case 'grain':
      return ['sum'];
    case 'references':
      return ['join'];
    case 'groupedBy':
      return ['group by'];
    default:
      return [probe.probe];
  }
}

function firstTable(sql: string): string | undefined {
  const match = /\bfrom\s+([A-Za-z_][\w]*)/i.exec(sql);
  return match?.[1];
}

/**
 * Attribution lessons, harvested from a real loop.
 *
 * Requirement 8 asks for the analysis experience to become tips, and the honest version of that is narrow: the
 * loop can teach four things, and each one is only claimed when the run actually shows it.
 *
 * - **batching**: one query per dimension instead of one per slice - a measured ratio of query counts.
 * - **which dimension is informative** for a metric: only when one slice carries most of the change.
 * - **a ratio needs its two factors**: a ratio's slices are not a decomposition, and a run that used the
 *   numerator/denominator split is the evidence.
 * - **a residual is a finding**: when the drivers do not cover the change, the lesson is "say so", and the
 *   number is the evidence.
 *
 * Nothing here is generated from a template alone: a tip with no run behind it is refused by the store, which
 * is what keeps this from becoming a growing list of plausible sentences.
 */
export function harvestFromAttribution(
  store: SkillStore,
  result: AttributionResult,
  context: HarvestContext = {},
): Tip[] {
  const tips: Tip[] = [];
  const metric = result.metric.replace(/^metric\//, '');
  const run = runId(result.metric, result.period.from, result.period.to, 'attribution');
  const actor = context.actor ?? 'agent';

  if (result.cost.naiveQueries >= result.cost.queries * 2 && result.cost.queries > 0) {
    tips.push(store.harvest({
      scope: { agent: 'attribution', shape: 'batching' },
      kind: 'prefer',
      statement: '归因的每一层用一条 GROUP BY 取全部切片（两个期间一起），不要按切片逐条查：'
        + `${result.cost.naiveQueries} 条可以压到 ${result.cost.queries} 条`,
      rationale: '切片逐条查询是归因循环里最大的开销；一条带 period 维度的分组查询同时给出所有切片和两个期间',
      applies: { keywords: ['attribution', 'groupby'] },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `${result.metric} ${result.period.from}→${result.period.to}: ${result.cost.queries} queries vs ${result.cost.naiveQueries} naive`,
        metrics: { queries: result.cost.queries, naiveQueries: result.cost.naiveQueries, iterations: result.cost.iterations },
      }],
      confidence: 0.85,
      createdBy: actor,
      now: context.now,
    }));
  }

  const bestSliceSet = [...result.root.sliceSets]
    .sort((a, b) => Math.abs(b.items[0]?.share ?? 0) - Math.abs(a.items[0]?.share ?? 0))[0];
  const top = bestSliceSet?.items[0];
  if (bestSliceSet && top && Math.abs(top.share) >= 0.5) {
    tips.push(store.harvest({
      scope: { agent: 'attribution', shape: 'dimension-informative' },
      kind: 'prefer',
      statement: `${metric} 的变化优先按 ${bestSliceSet.dimension.replace(/^dim\//, '')} 下钻：`
        + `${String(top.value)} 一项就占到 ${(top.share * 100).toFixed(1)}%`,
      rationale: `实测：${result.period.from}→${result.period.to} 期间该切片贡献 ${top.delta}`,
      applies: { keywords: [metric, bestSliceSet.dimension.replace(/^dim\//, '')] },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `${bestSliceSet.dimension} / ${String(top.value)}: share ${(top.share * 100).toFixed(1)}%`,
        metrics: { delta: result.root.delta, sliceDelta: top.delta, share: top.share },
      }],
      confidence: 0.75,
      createdBy: actor,
      now: context.now,
    }));
  }

  if (result.root.decomposition === 'ratio') {
    tips.push(store.harvest({
      scope: { agent: 'attribution', shape: 'ratio' },
      kind: 'check',
      statement: `比率指标（${metric}）用分子/分母两因子精确分解：Δ = (n1-n0)/d1 + n0*(1/d1 - 1/d0)；`
        + '切片之和没有意义，两项会相互抵消',
      rationale: '比率不是可加量；把它当加总分解会得出"占 -1215%"这类荒谬份额',
      applies: { keywords: [metric, 'ratio'] },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `ratio decomposition of ${result.metric}, residual ${result.root.unexplained?.absolute ?? 'n/a'}`,
        metrics: {
          delta: result.root.delta,
          drivers: result.root.drivers.length,
          residual: result.root.unexplained?.absolute ?? 0,
        },
      }],
      confidence: 0.85,
      createdBy: actor,
      now: context.now,
    }));
  }

  const unexplained = result.root.unexplained;
  if (unexplained && Math.abs(unexplained.share) > 0.01) {
    tips.push(store.harvest({
      scope: { agent: 'attribution', shape: 'residual' },
      kind: 'check',
      statement: `${metric} 的分解有 ${(Math.abs(unexplained.share) * 100).toFixed(1)}% 未解释：先把缺失的驱动指标补进模型，再对外解释`,
      rationale: `残差 ${unexplained.absolute}；未解释的部分不能归到"行业波动"这类说法上`,
      applies: { keywords: [metric, 'residual'] },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `unexplained ${unexplained.absolute} (${(unexplained.share * 100).toFixed(1)}%)`,
        metrics: { delta: result.root.delta, residual: unexplained.absolute, share: unexplained.share },
      }],
      confidence: 0.8,
      createdBy: actor,
      now: context.now,
    }));
  }

  if (result.root.decomposition === 'association') {
    tips.push(store.harvest({
      scope: { agent: 'attribution', shape: 'association' },
      kind: 'avoid',
      statement: `${metric} 的驱动只能报"同向变动"，不能声称分解：模型没有它的计算公式，也没有可加性`,
      rationale: '把关联说成贡献份额是最常见的过度解释；模型里没有公式就没有份额',
      applies: { keywords: [metric, 'drivers'] },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `association-only attribution for ${result.metric}`,
        metrics: { delta: result.root.delta, drivers: result.root.drivers.length },
      }],
      confidence: 0.8,
      createdBy: actor,
      now: context.now,
    }));
  }

  return tips;
}


/**
 * Campaign lessons: which cell deserves the budget, and what the data cannot support.
 *
 * The first one is the useful, falsifiable finding ("this cell's marginal return is twice the average, and it
 * is 18% under-allocated"). The second is the guardrail ("the curves only support ±50%; do not extrapolate a
 * doubling"), because a recommendation's credibility dies at the edge of its evidence.
 */
export function harvestFromCampaign(
  store: SkillStore,
  result: CampaignResult,
  context: HarvestContext = {},
): Tip[] {
  const tips: Tip[] = [];
  const actor = context.actor ?? 'agent';
  const run = runId('campaign', result.window.last, String(result.budget), 'campaign');

  const increase = [...result.cells].filter((cell) => cell.delta > 0)
    .sort((a, b) => b.expectedRevenueDelta - a.expectedRevenueDelta)[0];
  if (increase) {
    tips.push(store.harvest({
      scope: { agent: 'campaign', shape: 'marginal-roi' },
      kind: 'prefer',
      // The honest phrasing: a saturated cell's marginal is *below* its own average, and it is still the right
      // place for the next yuan when it is above the other cells' marginals. Saying "higher than average"
      // would be false, and the number is right there for anyone to check.
      statement: `加投优先 ${increase.id}：边际 ROI ${increase.marginalRoi}（自身平均 ${increase.currentRoi}）`
        + '——低于自身平均正是饱和的信号，但仍高于其他 cell 的边际回报，所以下一元应该放这里',
      rationale: `曲线预测加投 ${increase.delta} 可带来 ${increase.expectedRevenueDelta} 增量（${increase.curve.kind}，r²=${increase.curve.r2}）`,
      applies: { keywords: [increase.key.industry ?? '', increase.key.channel ?? '', increase.key.region ?? ''].filter((part) => part.length > 0) },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `${increase.id}: marginal ${increase.marginalRoi} vs average ${increase.currentRoi}, delta ${increase.delta}`,
        metrics: {
          delta: increase.delta,
          marginalRoi: increase.marginalRoi,
          currentRoi: increase.currentRoi,
          expectedRevenueDelta: increase.expectedRevenueDelta,
        },
      }],
      confidence: 0.8,
      createdBy: actor,
      now: context.now,
    }));
  }

  const weak = result.cells.filter((cell) => cell.curve.r2 < 0.6);
  if (weak.length > 0) {
    tips.push(store.harvest({
      scope: { agent: 'campaign', shape: 'curve-fit' },
      kind: 'check',
      statement: `${weak.length} 个 cell 的响应曲线 r² < 0.6（如 ${weak[0]!.id}）：这些 cell 的预测不可用于分配`,
      rationale: '拟合差的曲线给出的边际 ROI 只是噪声的另一种写法',
      applies: { keywords: ['campaign', 'curve'] },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `${weak.length} weak curves, worst r² ${Math.min(...weak.map((cell) => cell.curve.r2))}`,
        metrics: { weakCells: weak.length, worstR2: Math.min(...weak.map((cell) => cell.curve.r2)) },
      }],
      confidence: 0.75,
      createdBy: actor,
      now: context.now,
    }));
  }

  tips.push(store.harvest({
    scope: { agent: 'campaign', shape: 'bounds' },
    kind: 'check',
    statement: `投放再分配的可信幅度是每 cell 当前预算的 ±${Math.round(100 * Math.max(...result.cells.map((cell) => Math.abs(cell.delta) / Math.max(cell.currentSpend, 1)), 0))}%；更大幅度属于曲线外推`,
    rationale: '曲线只在历史 spend 区间内被数据支持；超出区间的建议是外推，不是结论',
    applies: { keywords: ['campaign', 'budget'] },
    evidence: [{
      runId: run, kind: 'plan',
      detail: `budget ${result.budget}, gain ${result.allocation.totals.expectedRevenueDelta}, noise ${result.allocation.totals.noise}`,
      metrics: {
        budget: result.budget,
        expectedRevenueDelta: result.allocation.totals.expectedRevenueDelta,
        noise: result.allocation.totals.noise,
      },
    }],
    confidence: 0.7,
    createdBy: actor,
    now: context.now,
  }));

  return tips;
}

/**
 * Risk lessons: which feature is worth a rule, and which rule is worth keeping.
 *
 * The valuable ones are not "AUC is high" - that is not a decision. They are: *this feature separates frauds at
 * this threshold with this precision*, and *this rule adds N new frauds the current stack misses*. Both carry
 * the numbers from the run, and both are scoped to the risk agent so they never leak into a campaign answer.
 */
export function harvestFromRisk(
  store: SkillStore,
  result: RiskResult,
  context: HarvestContext = {},
): Tip[] {
  const tips: Tip[] = [];
  const actor = context.actor ?? 'agent';
  const run = runId('risk', result.window.from, result.window.to, String(result.window.events));

  const bestFeature = [...result.features].filter((feature) => feature.usable)
    .sort((a, b) => b.auc - a.auc)[0];
  if (bestFeature) {
    tips.push(store.harvest({
      scope: { agent: 'risk', shape: 'feature-effectiveness' },
      kind: 'prefer',
      statement: `${bestFeature.name} 是目前最有效的风控特征（AUC ${bestFeature.auc}、KS ${bestFeature.ks}、IV ${bestFeature.iv}，`
        + `单调性 ${bestFeature.monotonicity}）；单调性不成立的特征不要只用"top 分位"做规则`,
      rationale: `在 ${result.window.events} 个事件上评估；PSI ${Number.isFinite(bestFeature.psi) ? bestFeature.psi : 'n/a'}`,
      applies: { keywords: ['risk', bestFeature.name] },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `${bestFeature.name}: AUC ${bestFeature.auc}, KS ${bestFeature.ks}, IV ${bestFeature.iv}`,
        metrics: { auc: bestFeature.auc, ks: bestFeature.ks, iv: bestFeature.iv, positives: bestFeature.positives },
      }],
      confidence: 0.8,
      createdBy: actor,
      now: context.now,
    }));
  }

  const published = result.rules.filter((rule) => rule.status === 'published');
  const candidate = published[0] ?? result.rules.find((rule) => rule.status === 'candidate');
  if (candidate?.holdout) {
    tips.push(store.harvest({
      scope: { agent: 'risk', shape: 'rule-backtest' },
      kind: 'prefer',
      statement: `规则「${candidate.expression}」在 holdout 上精确率 ${candidate.holdout.precision}、召回率 ${candidate.holdout.recall}，`
        + `比现有规则多抓 ${candidate.incremental?.newOnlyPositives ?? 0} 个欺诈（增量召回 ${((candidate.incremental?.incrementalRecall ?? 0) * 100).toFixed(2)}%）`,
      rationale: '规则的采纳标准是"新增抓到的欺诈"，而不是"规则本身的 AUC"',
      applies: { keywords: ['risk', 'rule', candidate.conditions[0]?.feature ?? ''] },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `${candidate.id}: P=${candidate.holdout.precision} R=${candidate.holdout.recall} on ${candidate.holdout.evaluated} events`,
        metrics: {
          precision: candidate.holdout.precision,
          recall: candidate.holdout.recall,
          incrementalRecall: candidate.incremental?.incrementalRecall ?? 0,
          newOnlyPositives: candidate.incremental?.newOnlyPositives ?? 0,
        },
      }],
      confidence: 0.8,
      createdBy: actor,
      now: context.now,
    }));
  }

  const leaking = result.rejectedFeatures.filter((feature) => !feature.pointInTime.ok);
  if (leaking.length > 0) {
    tips.push(store.harvest({
      scope: { agent: 'risk', shape: 'point-in-time' },
      kind: 'check',
      statement: `${leaking.map((feature) => feature.name).join('、')} 的快照日期晚于事件日期，是未来函数：`
        + '无论 AUC 多高都不能进规则（这类特征会在离线指标上"表现完美"）',
      rationale: `PIT 检查发现 ${leaking.reduce((total, feature) => total + feature.pointInTime.violations, 0)} 处违规`,
      applies: { keywords: ['risk', 'feature', 'as_of'] },
      evidence: [{
        runId: run, kind: 'plan',
        detail: `rejected features: ${leaking.map((feature) => feature.name).join(', ')}`,
        metrics: {
          rejectedFeatures: leaking.length,
          violations: leaking.reduce((total, feature) => total + feature.pointInTime.violations, 0),
        },
      }],
      confidence: 0.85,
      createdBy: actor,
      now: context.now,
    }));
  }

  return tips;
}
