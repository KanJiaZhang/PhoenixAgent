#!/usr/bin/env node
/**
 * Agent instance #1: 风控策略 — end to end, from a question to a published rule.
 *
 * The instance is a *manifest* (`agents/risk-strategy.agent.json`) plus this runner. The runner reads the
 * manifest for its gates and budgets, so the document is not decoration: change the gate in the JSON and the
 * run obeys it. What it does, in the order the product does it:
 *
 * ```
 * 1  route      the question is classified as a detective question for the risk agent
 * 2  trend      monthly change-point test finds the injected regime change, with the z it rests on
 * 3  features   AUC/KS/IV/PSI/monotonicity, and the point-in-time gate rejects the future function
 * 4  rules      ≤3-condition conjunctions, thresholds from quantiles
 * 5  backtest   holdout precision/recall + the increment over the two rules already live
 * 6  approve    a person writes an approval line; the agent never publishes by itself
 * 7  skills     the lessons land in the library, with the numbers that produced them
 * ```
 *
 * Run: `npm run example:risk`
 */

import { join } from 'node:path';
import { route } from '../packages/core/src/router.ts';
import { riskAgent, RiskApprovals } from '../packages/agents/risk/src/index.ts';
import { SkillStore } from '../packages/skills/src/types.ts';
import { harvestFromRisk } from '../packages/skills/src/harvest.ts';
import { advise } from '../packages/skills/src/advise.ts';
import { expect, finish, loadModel, money, openRun, prepareWorkspace, readSpec, writeArtifact } from './lib.mjs';

const spec = readSpec('risk-strategy');
const now = '2026-11-01T00:00:00.000Z';
const workspace = prepareWorkspace('risk');
const graph = spec.model.graph;

console.log(`\n=== ${spec.name} (${spec.id}) ===`);
console.log(`问题：${spec.question}\n`);

// --- 1. routing -----------------------------------------------------------------------------------
const decision = route(spec.question);
console.log(`[1] 路由: agent=${decision.agent} type=${decision.signature.type} confidence=${decision.confidence}`);
expect('问题被路由到风控 Agent', decision.agent === 'risk', `${decision.agent} / ${decision.signature.type}`);
expect('路由说明了依据（不是黑箱）', decision.signature.evidence.length > 0, decision.signature.evidence.join(', '));

const { stored, index } = loadModel(workspace, graph, now);
expect('语义模型可用于风控域', index.metrics.length > 0 && stored.candidates.length > 0, `${index.metrics.length} metrics`);

const { run, close } = openRun();
try {
  // --- 2..5. the pipeline -------------------------------------------------------------------------
  const report = riskAgent({
    run, graph, workspace,
    holdoutMonths: spec.gates.holdoutMonths,
    minPrecision: spec.gates.minPrecision,
    minRecall: spec.gates.minRecall,
  });
  expect('风控 Agent 没有拒绝（数据与标签足够）', report.refusals.length === 0,
    report.refusals.map((refusal) => refusal.message).join(' | '));

  const step = report.trends.filter((trend) => trend.dimension === 'region' && trend.changePoint).at(0);
  console.log(`[2] 趋势: 大区 ${step?.value} 在 ${step?.changePoint?.period} 出现拐点 `
    + `${(step?.changePoint?.before.rate * 100).toFixed(2)}% → ${(step?.changePoint?.after.rate * 100).toFixed(2)}% `
    + `(z=${step?.changePoint?.z}, 样本 ${step?.changePoint?.before.events}/${step?.changePoint?.after.events})`);
  expect('找到了注入的拐点（2025-07 前后一个周期内）', ['2025-06', '2025-07', '2025-08'].includes(step?.changePoint?.period),
    step?.changePoint?.period);
  expect('拐点有统计量，不是"看起来涨了"', (step?.changePoint?.z ?? 0) >= spec.gates.minZ,
    `z=${step?.changePoint?.z}`);

  const leaky = report.rejectedFeatures.find((feature) => !feature.pointInTime.ok);
  console.log(`[3] 特征: 可用 ${report.features.filter((feature) => feature.usable).length}/${report.features.length}；`
    + `剔除未来函数 ${leaky?.name ?? '无'}（AUC ${leaky?.auc}，as_of > event_date ${leaky?.pointInTime.violations} 处）`);
  expect('未来函数被 point-in-time 硬门拒绝', leaky !== undefined && leaky.auc > 0.9,
    `${leaky?.name} AUC ${leaky?.auc}`);
  const best = report.features.find((feature) => feature.usable && feature.name === 'model_score_v1');
  expect('主特征的有效性四项齐全', Number.isFinite(best?.auc) && Number.isFinite(best?.ks)
    && Number.isFinite(best?.iv) && Number.isFinite(best?.psi), `AUC ${best?.auc} KS ${best?.ks} IV ${best?.iv}`);

  const recommended = report.rules.filter((rule) => rule.status === 'candidate' || rule.status === 'published');
  const winner = recommended[0];
  console.log(`[4] 规则: ${recommended.length} 条候选；首选 \`${winner?.expression}\``);
  console.log(`[5] 回测: holdout P=${winner?.holdout.precision} R=${winner?.holdout.recall} `
    + `覆盖 ${(winner?.holdout.coverage * 100).toFixed(2)}% lift ${winner?.holdout.lift} `
    + `(TP ${winner?.holdout.tp}/FP ${winner?.holdout.fp}, 窗口 ${winner?.holdout.window})`);
  console.log(`    与存量规则相比: 新增抓到 ${winner?.incremental.newOnlyPositives} 个欺诈、`
    + `重叠 ${(winner?.incremental.overlapShare * 100).toFixed(1)}%、增量召回 ${(winner?.incremental.incrementalRecall * 100).toFixed(2)}%`);
  expect('首选规则达到 manifest 里的 precision/recall 门',
    winner.holdout.precision >= spec.gates.minPrecision && winner.holdout.recall >= spec.gates.minRecall,
    `P=${winner.holdout.precision} R=${winner.holdout.recall}`);
  expect('规则不超过 3 个条件', winner.conditions.length <= spec.gates.maxConditions, `${winner.conditions.length}`);
  expect('回测样本与混淆矩阵自洽',
    winner.holdout.tp + winner.holdout.fp + winner.holdout.fn + winner.holdout.tn === winner.holdout.evaluated);
  expect('有相对存量规则的增量', winner.incremental.newOnlyPositives > 0, `+${winner.incremental.newOnlyPositives}`);

  // --- 6. the human gate -------------------------------------------------------------------------
  const approvals = new RiskApprovals(workspace, graph);
  console.log(`[6] 审批前 published = ${report.published.length}`);
  expect('Agent 自己绝不发布', report.published.length === 0);

  const approval = approvals.decide(winner.id, winner.expression, 'approve', 'risk-lead@demo',
    `holdout P=${winner.holdout.precision} R=${winner.holdout.recall}，增量 +${winner.incremental.newOnlyPositives}，同意上线`, now);
  const after = riskAgent({
    run, graph, workspace,
    holdoutMonths: spec.gates.holdoutMonths, minPrecision: spec.gates.minPrecision, minRecall: spec.gates.minRecall,
  });
  console.log(`    审批后 published = ${after.published.length}（${after.published[0]?.id} by ${after.published[0]?.approvedBy}）`);
  expect('只有被批准的规则进入 published', after.published.length === 1 && after.published[0].id === winner.id);
  expect('审批记录带审批人与时间', approval.actor === 'risk-lead@demo' && approval.ts === now);

  // --- 7. skills ----------------------------------------------------------------------------------
  const store = new SkillStore(join(workspace, 'skills'));
  const tips = harvestFromRisk(store, after, { actor: 'risk-strategy-agent', now });
  console.log(`[7] 经验: 沉淀 ${tips.length} 条 tip`);
  for (const tip of tips) console.log(`    - [${tip.kind}] ${tip.statement.slice(0, 88)}`);
  expect('规则与特征的教训都进了 skill 库', tips.length >= 2);
  const advice = advise(store, 'risk feature model_score_v1 rule', { limit: 3 });
  expect('Skill 库能被检索到', advice.advice.length > 0, advice.advice.map((entry) => entry.tip.id).join(', '));

  // --- artifacts ----------------------------------------------------------------------------------
  const artifacts = {
    routing: decision,
    trend: report.trends.filter((trend) => trend.changePoint || trend.spikes.length > 0),
    features: report.features,
    rejectedFeatures: report.rejectedFeatures,
    rules: report.rules,
    published: after.published,
    approval,
    tips: tips.map((tip) => ({ id: tip.id, statement: tip.statement, evidence: tip.evidence })),
  };
  const dir = join(workspace, 'artifacts');
  for (const name of ['trend.json', 'features.json', 'rules.json', 'approval.json', 'skills.json']) {
    const key = name === 'trend.json' ? 'trend' : name === 'features.json' ? 'features'
      : name === 'rules.json' ? 'rules' : name === 'approval.json' ? 'approval' : 'tips';
    writeArtifact(workspace, name, artifacts[key]);
  }
  console.log(`\n产物: ${dir}（${spec.outputs.join(', ')}）`);
  console.log('\n一句话结论：' + after.explanation.split('\n').slice(0, 4).join('\n'));
  finish('风控策略 Agent');
} finally {
  close();
}
