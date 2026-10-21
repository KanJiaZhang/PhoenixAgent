#!/usr/bin/env node
/**
 * Agent instance #2: 归因 + 市场决策 — one question, two agents, one handoff a marketing lead can act on.
 *
 * ```
 * 1  route        「11 月花费为什么涨了？预算该往哪调？」→ diagnostic + prescriptive
 * 2  attribute    the loop drills from the total into the drivers and slices, and states its residual
 * 3  explain      the narrative carries the numbers, not adjectives; no causal claims
 * 4  optimize     marginal response curves per cell, bounded reallocation, holdout design
 * 5  handoff      what changed / where the money should go / what would prove it wrong
 * 6  skills       both lessons land in the library with the numbers that produced them
 * ```
 *
 * Run: `npm run example:growth`
 */

import { join } from 'node:path';
import { route } from '../packages/core/src/router.ts';
import { attribute } from '../packages/agents/attribution/src/index.ts';
import { campaign } from '../packages/agents/campaign/src/index.ts';
import { SkillStore } from '../packages/skills/src/types.ts';
import { harvestFromAttribution, harvestFromCampaign } from '../packages/skills/src/harvest.ts';
import { advise } from '../packages/skills/src/advise.ts';
import { expect, finish, loadModel, money, openRun, prepareWorkspace, readSpec, writeArtifact } from './lib.mjs';
import { writeFileSync } from 'node:fs';

const spec = readSpec('attribution-campaign');
const now = '2026-11-01T00:00:00.000Z';
const workspace = prepareWorkspace('growth');
const graph = spec.model.graph;

console.log(`\n=== ${spec.name} (${spec.id}) ===`);
console.log(`问题：${spec.question}\n`);

// --- 1. routing -----------------------------------------------------------------------------------
const decision = route(spec.question);
console.log(`[1] 路由: agent=${decision.agent} type=${decision.signature.type} confidence=${decision.confidence}`);
expect('问题被识别为诊断型（找原因）', decision.signature.type === 'diagnostic', decision.signature.type);
expect('路由带走结构信息（指标与维度）', decision.signature.metrics.length > 0 || decision.signature.evidence.length > 0,
  `${decision.signature.metrics.join(',')} / ${decision.signature.evidence.join(',')}`);

const { index } = loadModel(workspace, graph, now);
const { run, close } = openRun();
try {
  // --- 2..3. attribution --------------------------------------------------------------------------
  const attribution = attribute({
    metric: 'spend', from: '2025-10', to: '2025-11', index, run,
    maxDepth: spec.gates.attribution.maxDepth,
    maxQueries: spec.gates.attribution.maxQueries,
    pruneShare: spec.gates.attribution.pruneShare,
    expandShare: spec.gates.attribution.expandShare,
  });
  expect('归因没有拒绝', attribution.refusals.length === 0, attribution.refusals.map((r) => r.message).join(' | '));
  const root = attribution.root;
  console.log(`[2] 归因: spend ${money(root.previous)} → ${money(root.current)}，变动 ${money(root.delta)}（${root.decomposition}）`);
  const regionSet = root.sliceSets.find((set) => set.dimension === 'dim/region');
  const channelSet = root.sliceSets.find((set) => set.dimension === 'dim/channel');
  for (const set of [regionSet, channelSet].filter(Boolean)) {
    console.log(`    按 ${set.dimension.replace('dim/', '')}: ` + set.items.slice(0, 3)
      .map((item) => `${item.value} ${money(item.delta)}（${(item.share * 100).toFixed(1)}%）`).join('、'));
  }
  console.log(`    下钻路径: ${attribution.path.map((node) => node.label ?? node.metric.replace('metric/', '')).join(' → ')}`);

  expect('分解是可加的（sum of slices = delta）',
    Math.abs(regionSet.items.reduce((sum, item) => sum + item.delta, 0) - root.delta) < 1e-6,
    `${regionSet.items.reduce((sum, item) => sum + item.delta, 0).toFixed(2)} vs ${root.delta}`);
  expect('残差被显式报出（这里应为 0）', root.unexplained !== null && Math.abs(root.unexplained.share) < 1e-6,
    JSON.stringify(root.unexplained));
  expect('下钻至少两层', attribution.path.length >= 3, attribution.path.map((node) => node.label ?? node.metric).join(' → '));
  expect('批量取数（查询数 < 朴素切片数）', attribution.cost.queries < attribution.cost.naiveQueries * 0.5,
    `${attribution.cost.queries} vs ${attribution.cost.naiveQueries}`);
  expect('在预算内', attribution.cost.queries <= spec.gates.attribution.maxQueries);
  expect('叙述不含因果词', !/导致|因为|造成|致使/.test(attribution.explanation), 'ok');
  expect('叙述声明了"描述性"', /不是因果结论/.test(attribution.explanation));

  // the ratio case, to show the exact two-factor split on the same window
  const roi = attribute({ metric: 'roi', from: '2025-10', to: '2025-11', index, run, maxDepth: 1 });
  const effects = roi.root.drivers.reduce((sum, driver) => sum + driver.contribution, 0);
  console.log(`[3] 比率: ROI ${roi.root.previous.toFixed(4)} → ${roi.root.current.toFixed(4)}，`
    + `分子项 ${roi.root.drivers[0]?.contribution.toFixed(4)} + 分母项 ${roi.root.drivers[1]?.contribution.toFixed(4)}`);
  expect('比率分解两项之和 = 变动且无残差',
    Math.abs(effects - roi.root.delta) < 1e-9 && Math.abs(roi.root.unexplained.absolute) < 1e-9);

  // --- 4. campaign --------------------------------------------------------------------------------
  const plan = campaign({
    run, index,
    maxChangePct: spec.gates.campaign.maxChangePct,
    minShare: spec.gates.campaign.minShare,
    maxShare: spec.gates.campaign.maxShare,
  });
  expect('投放决策没有拒绝', plan.refusals.length === 0, plan.refusals.map((r) => r.message).join(' | '));
  const totals = plan.allocation.totals;
  console.log(`[4] 投放: 预算 ${money(plan.budget)}；预计收入 ${money(totals.expectedRevenueCurrent)} → `
    + `${money(totals.expectedRevenueProposed)}（+${money(totals.expectedRevenueDelta)}，${(totals.improvementPct * 100).toFixed(2)}%；`
    + `曲线噪声 ${money(totals.noise)}）`);
  for (const move of plan.topMoves.slice(0, 4)) {
    console.log(`    ${move.delta >= 0 ? '加投' : '减投'} ${move.cell} ${money(move.delta)}（边际 ROI ${move.marginalRoi}，平均 ${move.currentRoi}）`);
  }
  console.log(`    holdout: ${plan.holdout.design} ${plan.holdout.horizonWeeks} 周，所需 ${plan.holdout.requiredUnitsPerArm} / 可用 ${plan.holdout.availableUnits} → ${plan.holdout.feasible ? '可行' : '不可行'}`);

  const conserved = Math.abs(plan.cells.reduce((sum, cell) => sum + cell.proposedSpend, 0) - plan.budget) < 1e-3;
  expect('预算守恒', conserved);
  expect('每个 cell 的变动在 ±maxChangePct 内',
    plan.cells.every((cell) => Math.abs(cell.delta) <= cell.currentSpend * spec.gates.campaign.maxChangePct + 1e-3));
  expect('预计增益超过曲线噪声（否则不该建议）', totals.expectedRevenueDelta > totals.noise,
    `${money(totals.expectedRevenueDelta)} vs ${money(totals.noise)}`);
  expect('每个建议都挂着曲线参数与拟合度',
    plan.cells.every((cell) => Object.keys(cell.curve.params).length > 0 && cell.curve.points >= 5));
  expect('带 holdout 设计与样本量算术', plan.holdout.design === 'geoholdout' && plan.holdout.horizonWeeks > 0);
  expect('叙述把收益标为"模型预计"', /模型预计/.test(plan.explanation));
  expect('限制里写明是外推、需先验证', plan.limits.some((limit) => /外推/.test(limit)) && plan.limits.some((limit) => /holdout|验证/.test(limit)));

  // --- 5. handoff ---------------------------------------------------------------------------------
  const increases = plan.cells.filter((cell) => cell.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3);
  const decreases = plan.cells.filter((cell) => cell.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);
  const topRegion = regionSet.items[0];
  const handoff = `# 11 月投放复盘与下期预算建议

## 1. 发生了什么
- 投放花费从 ${money(root.previous)} 涨到 ${money(root.current)}，变动 **${money(root.delta)}**（${root.decomposition} 分解，残差 ${money(root.unexplained.absolute)}）。
- 贡献最大的是 ${topRegion.value}（${money(topRegion.delta)}，占 ${(topRegion.share * 100).toFixed(1)}%）；
  按渠道看 ${channelSet.items[0].value} 增长最多（${money(channelSet.items[0].delta)}，${(channelSet.items[0].share * 100).toFixed(1)}%）。
- ROI 同期 ${roi.root.previous.toFixed(4)} → ${roi.root.current.toFixed(4)}：分子（收入）项 ${roi.root.drivers[0]?.contribution.toFixed(4)}，
  分母（花费）项 ${roi.root.drivers[1]?.contribution.toFixed(4)}——花费涨得比收入快，所以 ROI 被摊薄。

## 2. 下期怎么调（模型预计，按边际回报而非平均 ROI）
| 方向 | cell | 当前花费 | 调整 | 边际 ROI（当前） | 预计收入变化 |
| --- | --- | --- | --- | --- | --- |
${[...increases, ...decreases].map((cell) => `| ${cell.delta >= 0 ? '加投' : '减投'} | ${cell.id} | ${money(cell.currentSpend)} | ${cell.delta >= 0 ? '+' : ''}${money(cell.delta)} | ${cell.marginalRoi}（平均 ${cell.currentRoi}） | ${money(cell.expectedRevenueDelta)} |`).join('\n')}

预算不变（${money(plan.budget)}），模型预计收入 ${money(totals.expectedRevenueCurrent)} → ${money(totals.expectedRevenueProposed)}
（+${money(totals.expectedRevenueDelta)}，${(totals.improvementPct * 100).toFixed(2)}%），高于曲线噪声 ${money(totals.noise)}。
每个 cell 的调整都不超过当前预算的 ${Math.round(spec.gates.campaign.maxChangePct * 100)}%。

## 3. 怎么验证（先小规模，再全量）
- 设计：${plan.holdout.design}，处理组「${plan.holdout.treatment}」，对照组 ${plan.holdout.control}，观察 ${plan.holdout.horizonWeeks} 周。
- 所需样本 ${plan.holdout.requiredUnitsPerArm} 个 cell-月，可用 ${plan.holdout.availableUnits} → **${plan.holdout.feasible ? '可行' : '不可行'}**。
- ${plan.holdout.note}

## 4. 这些数字的边界
${plan.limits.map((limit) => `- ${limit}`).join('\n')}
- 归因是描述性分解，不是因果结论：花费涨了与收入涨了同时发生，不代表前者"导致"后者。
`;
  const handoffPath = join(workspace, 'artifacts', 'handoff.md');
  writeArtifact(workspace, 'handoff.md', handoff);
  writeFileSync(handoffPath, handoff);
  expect('交接单包含"发生了什么/怎么调/怎么验证/边界"四段', ['发生了什么', '怎么调', '怎么验证', '边界'].every((part) => handoff.includes(part)));
  expect('交接单里不出现"保证/一定"', !/保证|一定能|必然/.test(handoff));

  // --- 6. skills ----------------------------------------------------------------------------------
  const store = new SkillStore(join(workspace, 'skills'));
  const tips = [
    ...harvestFromAttribution(store, attribution, { actor: 'growth-agent', now }),
    ...harvestFromAttribution(store, roi, { actor: 'growth-agent', now }),
    ...harvestFromCampaign(store, plan, { actor: 'growth-agent', now }),
  ];
  console.log(`[6] 经验: 沉淀 ${tips.length} 条 tip`);
  for (const tip of tips.slice(0, 5)) console.log(`    - [${tip.kind}] ${tip.statement.slice(0, 80)}`);
  expect('归因与投放两侧的教训都入库', tips.length >= 4);
  const advice = advise(store, 'campaign budget 直播 3C数码', { limit: 3 });
  expect('Skill 库能被后续检索到', advice.advice.length > 0, advice.advice.map((entry) => entry.tip.id).join(', '));

  // --- artifacts ----------------------------------------------------------------------------------
  writeArtifact(workspace, 'attribution.json', { decision, spend: attribution, roi });
  writeArtifact(workspace, 'campaign.json', plan);
  writeArtifact(workspace, 'skills.json', tips.map((tip) => ({ id: tip.id, statement: tip.statement, kind: tip.kind })));
  console.log(`\n产物: ${join(workspace, 'artifacts')}（${spec.outputs.join(', ')}）`);

  console.log(`\n=== 交接摘要 ===\n${handoff.split('\n').slice(0, 12).join('\n')}`);
  finish('归因 + 市场决策 Agent');
} finally {
  close();
}
