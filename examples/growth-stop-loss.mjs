#!/usr/bin/env node
/**
 * Agent instance #4: 止损归因 + 砍预算决策 — the opposite direction from instance #2 (which spends the same
 * budget better). Here the question is whether to spend **less**, and that changes three things:
 *
 * ```
 * 1  route     两个子问题：「为什么 ROI 被摊薄」→ 归因；「该砍哪些 cell」→ 投放
 * 2  attribute ROI 的两因子分解：分子（收入）效应 + 分母（花费）效应，和为变动、残差 0
 * 3  cross-check 跨事实口径：revenue 涨了，但 gmv 涨得一样快吗？（capture_rate，须先被采纳）
 * 4  stop-loss 预算上限 85% + 利润目标：允许不花满预算，砍掉边际回报 < 1 的 cell
 * 5  holdout   砍量不能用地区对照（会把需求差异混进来）→ switchback（按周交替）
 * 6  handoff   止损清单 + 验证方案 + 边界
 * 7  skills    两侧教训入库
 * ```
 *
 * Run: `npm run example:stoploss`
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { route } from '../packages/core/src/router.ts';
import { attribute } from '../packages/agents/attribution/src/index.ts';
import { campaign } from '../packages/agents/campaign/src/index.ts';
import { ask } from '../packages/semantic/src/ask/index.ts';
import { ReviewLog } from '../packages/semantic/src/review.ts';
import { SkillStore } from '../packages/skills/src/types.ts';
import { harvestFromAttribution, harvestFromCampaign } from '../packages/skills/src/harvest.ts';
import { expect, finish, loadModel, money, openRun, prepareWorkspace, readSpec, writeArtifact } from './lib.mjs';

const spec = readSpec('growth-stop-loss');
const now = '2026-11-03T00:00:00.000Z';
const workspace = prepareWorkspace('stoploss');
const graph = spec.model.graph;

console.log(`\n=== ${spec.name} (${spec.id}) ===`);
console.log(`问题：${spec.question}\n`);

// --- 1. routing: one business question, two agents ------------------------------------------------
const q1 = '为什么 2025 年 11 月的 ROI 被摊薄了';
const q2 = '该砍掉哪些 cell 的预算';
const d1 = route(q1);
const d2 = route(q2);
console.log(`[1] 路由: 「${q1}」→ ${d1.agent}（${d1.signature.type}） · 「${q2}」→ ${d2.agent}（${d2.signature.type}）`);
expect('"为什么"被路由到归因', d1.agent === 'attribution', `${d1.agent}/${d1.signature.type}`);
expect('"该砍哪里"被路由到投放决策', d2.agent === 'campaign', `${d2.agent}/${d2.signature.type}`);

const { index, candidates } = loadModel(workspace, graph, now);
const { run, close } = openRun();
try {
  // --- 2. attribution: the ratio's two factors ---------------------------------------------------
  const roi = attribute({ metric: 'roi', from: '2025-10', to: '2025-11', index, run, maxDepth: 1 });
  expect('ROI 归因没有拒绝', roi.refusals.length === 0, roi.refusals.map((r) => r.message).join(' | '));
  const [numerator, denominator] = roi.root.drivers;
  const effects = roi.root.drivers.reduce((sum, driver) => sum + driver.contribution, 0);
  console.log(`[2] ROI ${roi.root.previous.toFixed(4)} → ${roi.root.current.toFixed(4)}（Δ ${roi.root.delta.toFixed(4)}）`);
  console.log(`    分子（${numerator.metric.replace('metric/', '')}）项 ${numerator.contribution.toFixed(4)} · `
    + `分母（${denominator.metric.replace('metric/', '')}）项 ${denominator.contribution.toFixed(4)}`);
  expect('两项之和 = 变动，残差为 0',
    Math.abs(effects - roi.root.delta) < 1e-9 && Math.abs(roi.root.unexplained.absolute) < 1e-9);
  expect('分母效应为负（花费涨得比收入快）', denominator.contribution < 0, denominator.contribution.toFixed(4));

  // --- 3. cross-fact check: did the revenue turn into orders? -------------------------------------
  const captureId = spec.gates.crossFactCheck.metric;
  const unreviewed = ask({ question: '2025年11月各大区捕获率', index, run });
  console.log(`[3] 跨事实口径: 采纳前 ${unreviewed.refusals?.[0]?.code ?? 'answered'}`);
  expect('未采纳的跨事实指标被问数面拒绝', unreviewed.refusals?.[0]?.code === 'unvalidated');
  new ReviewLog(join(workspace, 'reviews', `${graph}.jsonl`)).append({
    ts: now, actor: 'analyst@demo', action: 'accept', target: captureId, reason: '止损分析要用 gmv/revenue 口径',
  });
  const reviewed = loadModel(workspace, graph, now).index;
  const capture = ask({ question: '2025年11月各大区捕获率', index: reviewed, run });
  expect('采纳后能算出捕获率', capture.answer !== undefined, JSON.stringify(capture.refusals));
  const gmvOct = ask({ question: '2025年10月GMV', index: reviewed, run });
  const gmvNov = ask({ question: '2025年11月GMV', index: reviewed, run });
  const revOct = ask({ question: '2025年10月营收', index: reviewed, run });
  const revNov = ask({ question: '2025年11月营收', index: reviewed, run });
  const gmvGrowth = (gmvNov.answer.total - gmvOct.answer.total) / gmvOct.answer.total;
  const revGrowth = (revNov.answer.total - revOct.answer.total) / revOct.answer.total;
  console.log(`    GMV ${money(gmvOct.answer.total)} → ${money(gmvNov.answer.total)}（${(gmvGrowth * 100).toFixed(1)}%）；`
    + `归因收入 ${money(revOct.answer.total)} → ${money(revNov.answer.total)}（${(revGrowth * 100).toFixed(1)}%）`);
  console.log(`    捕获率: ${(gmvOct.answer.total / revOct.answer.total * 100).toFixed(2)}% → `
    + `${(gmvNov.answer.total / revNov.answer.total * 100).toFixed(2)}%（跨事实口径，逐区见产物）`);
  expect('捕获率随收入增长被摊薄（收入涨得比成交快）', revGrowth > gmvGrowth,
    `${(revGrowth * 100).toFixed(1)}% vs ${(gmvGrowth * 100).toFixed(1)}%`);
  expect('跨事实指标按区给出结果', capture.answer.rows.length === 4, capture.answer.rows.map((row) => row.value).join(','));

  // --- 4. stop-loss: less budget, profit objective -----------------------------------------------
  const base = campaign({ run, index });
  const cap = Math.round(base.budget * spec.gates.campaign.budgetFactor);
  const stopLoss = campaign({
    run, index, budget: cap,
    objective: spec.gates.campaign.objective,
    budgetIsCap: spec.gates.campaign.budgetIsCap,
    maxChangePct: spec.gates.campaign.maxChangePct,
  });
  expect('止损方案没有被拒绝', stopLoss.refusals.length === 0, stopLoss.refusals.map((r) => r.message).join(' | '));
  const totals = stopLoss.allocation.totals;
  const unspent = totals.proposedSpend;
  console.log(`[4] 止损: 预算上限 ${money(cap)}（原 ${money(base.budget)}）；提议花费 ${money(unspent)}，`
    + `未花 ${money(cap - unspent)}`);
  console.log(`    收入 ${money(totals.expectedRevenueCurrent)} → ${money(totals.expectedRevenueProposed)}（${money(totals.expectedRevenueDelta)}），`
    + `利润 ${money(totals.expectedProfitCurrent)} → ${money(totals.expectedProfitProposed)}（+${money(totals.expectedProfitDelta)}）`);
  const cuts = stopLoss.cells.filter((cell) => cell.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);
  for (const cut of cuts) {
    console.log(`    砍 ${cut.id} ${money(cut.delta)}（边际 ROI ${cut.marginalRoi}，平均 ${cut.currentRoi}）`);
  }
  expect('利润上升，即使收入下降', totals.expectedProfitDelta > 0 && totals.expectedRevenueDelta < 0,
    `profit+${money(totals.expectedProfitDelta)} rev${money(totals.expectedRevenueDelta)}`);
  expect('花费不超过预算上限', totals.proposedSpend <= cap + 1e-3, `${money(totals.proposedSpend)} ≤ ${money(cap)}`);
  expect('确实有未被花掉的预算（止损的本质）', cap - totals.proposedSpend > 0,
    `未花 ${money(cap - totals.proposedSpend)}`);
  expect('每个 cell 的变动仍在 ±maxChangePct 内',
    stopLoss.cells.every((cell) => Math.abs(cell.delta) <= cell.currentSpend * spec.gates.campaign.maxChangePct + 1e-3));
  expect('砍掉的都是边际回报低的 cell',
    cuts.every((cell) => cell.marginalRoi < 1), cuts.map((cell) => `${cell.id}:${cell.marginalRoi}`).join(', '));

  // --- 5. the holdout for a cut is a switchback --------------------------------------------------
  console.log(`[5] 验证: ${stopLoss.holdout.design} · ${stopLoss.holdout.treatment} · 对照 ${stopLoss.holdout.control}`);
  console.log(`    所需 ${stopLoss.holdout.requiredUnitsPerArm} / 可用 ${stopLoss.holdout.availableUnits} → ${stopLoss.holdout.feasible ? '可行' : '不可行'}`);
  expect('砍量用 switchback 而不是地区对照', stopLoss.holdout.design === 'switchback');
  expect('对照是"同一批 cell 的对照周"', /对照周/.test(stopLoss.holdout.control), stopLoss.holdout.control);

  // --- 6. handoff ---------------------------------------------------------------------------------
  const handoff = `# 止损复盘：ROI 被摊薄，该砍哪里

## 1. 为什么摊薄了（描述性分解，不是因果结论）
- ROI ${roi.root.previous.toFixed(4)} → ${roi.root.current.toFixed(4)}，变动 ${roi.root.delta.toFixed(4)}。
- 分子（归因收入）效应 **${numerator.contribution.toFixed(4)}**；分母（花费）效应 **${denominator.contribution.toFixed(4)}**。
  两项相抵即总变动（残差 ${roi.root.unexplained.absolute}）：收入在涨，但花费涨得更快。
- 跨事实口径校验：GMV ${(gmvGrowth * 100).toFixed(1)}% vs 归因收入 ${(revGrowth * 100).toFixed(1)}%，
  **捕获率由 ${(gmvOct.answer.total / revOct.answer.total * 100).toFixed(2)}% 降到 ${(gmvNov.answer.total / revNov.answer.total * 100).toFixed(2)}%**
  —— 收入没有等比例变成成交。

## 2. 砍哪里（预算上限 ${money(cap)}，利润目标）
| cell | 当前花费 | 调整 | 边际 ROI（平均） | 预计收入变化 |
| --- | --- | --- | --- | --- |
${cuts.map((cell) => `| ${cell.id} | ${money(cell.currentSpend)} | ${money(cell.delta)} | ${cell.marginalRoi}（${cell.currentRoi}） | ${money(cell.expectedRevenueDelta)} |`).join('\n')}

- 提议花费 **${money(unspent)}**（上限 ${money(cap)}），**留出 ${money(cap - unspent)} 不花**。
- 模型预计：收入 ${money(totals.expectedRevenueDelta)}，**利润 +${money(totals.expectedProfitDelta)}**。
  砍的是边际回报小于 1 的花费：省下的 1 元比它挣回的更多。

## 3. 怎么验证不是把生意砍坏
- 设计：**${stopLoss.holdout.design}**——同一批 cell 按周交替执行/不执行调整，避免把地区需求差异当成效果。
- 处理：${stopLoss.holdout.treatment}；对照：${stopLoss.holdout.control}；观察 ${stopLoss.holdout.horizonWeeks} 周。
- 样本：所需 ${stopLoss.holdout.requiredUnitsPerArm} / 可用 ${stopLoss.holdout.availableUnits} → ${stopLoss.holdout.feasible ? '可行' : '不可行'}。
- ${stopLoss.holdout.note}

## 4. 边界
${stopLoss.limits.map((limit) => `- ${limit}`).join('\n')}
- 归因是描述性分解，不是因果结论；捕获率下降说明"收入与成交脱节"，不说明是哪一步脱节的。
`;
  writeArtifact(workspace, 'handoff.md', handoff);
  writeFileSync(join(workspace, 'artifacts', 'handoff.md'), handoff);
  expect('交接单写清"为什么/砍哪里/怎么验证/边界"', ['为什么摊薄', '砍哪里', '怎么验证', '边界'].every((part) => handoff.includes(part)));
  expect('交接单明确"留出不花的钱"', /不花/.test(handoff));

  // --- 7. skills ----------------------------------------------------------------------------------
  const store = new SkillStore(join(workspace, 'skills'));
  const tips = [
    ...harvestFromAttribution(store, roi, { actor: 'stop-loss-agent', now }),
    ...harvestFromCampaign(store, stopLoss, { actor: 'stop-loss-agent', now }),
  ];
  console.log(`[7] 经验: 沉淀 ${tips.length} 条 tip`);
  for (const tip of tips.slice(0, 4)) console.log(`    - [${tip.kind}] ${tip.statement.slice(0, 78)}`);
  expect('归因与止损两侧的教训入库', tips.length >= 3);
  expect('止损的教训包含"留出预算"这一条', tips.some((tip) => /边际|预算|上限/.test(tip.statement)));

  writeArtifact(workspace, 'roi-attribution.json', roi);
  writeArtifact(workspace, 'cross-check.json', { gmvOct: gmvOct.answer, gmvNov: gmvNov.answer, revOct: revOct.answer, revNov: revNov.answer, capture });
  writeArtifact(workspace, 'stop-loss-plan.json', stopLoss);
  writeArtifact(workspace, 'skills.json', tips.map((tip) => ({ id: tip.id, statement: tip.statement })));
  console.log(`\n产物: ${join(workspace, 'artifacts')}（${spec.outputs.join(', ')}）`);
  console.log(`\n=== 交接摘要 ===\n${handoff.split('\n').slice(0, 12).join('\n')}`);
  finish('止损归因 + 砍预算决策 Agent');
} finally {
  close();
}
