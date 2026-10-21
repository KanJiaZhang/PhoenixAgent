#!/usr/bin/env node
/**
 * Agent instance #3: 风控策略巡检 — the question nobody automates: are the live rules still worth their cost?
 *
 * Different workflow from instance #1 (which builds a rule). Here the rules already exist and the job is
 * governance, measured on a recent holdout window:
 *
 * ```
 * 1  route     「现有规则还值得留着吗？」→ risk
 * 2  audit     per rule: hits, precision, recall, coverage, intercepts/day
 * 3  overlap   how much of each rule's work another rule already does (Jaccard on hit sets)
 * 4  drift     PSI of the features each rule uses, first half vs second half of the window
 * 5  verdict   keep / retune / retire, with the reasons that produced it
 * 6  impact    what retiring them would cost (lost positives) and save (interceptions)
 * 7  guard     the agent changed nothing: the rules are still active, retiring is a human decision
 * ```
 *
 * Run: `npm run example:audit`
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { route } from '../packages/core/src/router.ts';
import { auditRules } from '../packages/agents/risk/src/index.ts';
import { SkillStore } from '../packages/skills/src/types.ts';
import { expect, finish, openRun, prepareWorkspace, readSpec, writeArtifact } from './lib.mjs';
import { writeFileSync } from 'node:fs';

const spec = readSpec('risk-rule-audit');
const now = '2026-11-02T00:00:00.000Z';
const workspace = prepareWorkspace('audit');

console.log(`\n=== ${spec.name} (${spec.id}) ===`);
console.log(`问题：${spec.question}\n`);

// --- 1. routing -----------------------------------------------------------------------------------
const decision = route(spec.question);
console.log(`[1] 路由: agent=${decision.agent} type=${decision.signature.type} confidence=${decision.confidence}`);
expect('问题被路由到风控 Agent', decision.agent === 'risk', `${decision.agent} / ${decision.signature.type}`);

const { run, close } = openRun();
try {
  // --- 2..5. the audit ----------------------------------------------------------------------------
  const audit = auditRules({
    run,
    holdoutMonths: spec.gates.holdoutMonths,
    minPrecision: spec.gates.minPrecision,
    driftThreshold: spec.gates.driftThreshold,
  });
  console.log(`[2] 巡检窗口: ${audit.window.from} ~ ${audit.window.to}（${audit.window.events} 事件 / ${audit.window.frauds} 欺诈 / ${audit.window.days} 天）`);
  expect('巡检覆盖了所有存量规则', audit.rules.length >= 2, `${audit.rules.length} rules`);
  expect('巡检不消耗预算之外的东西', audit.cost.queries <= spec.budget.maxQueries, `${audit.cost.queries} queries`);

  for (const rule of audit.rules) {
    const overlap = rule.overlap.map((entry) => `${entry.ruleId} ${(entry.jaccard * 100).toFixed(0)}%`).join('、') || '—';
    console.log(`[3] ${rule.ruleId} \`${rule.expression}\``);
    console.log(`    命中 ${rule.hits} · 精确率 ${rule.precision} · 召回 ${rule.recall} · 覆盖 ${(rule.coverage * 100).toFixed(2)}%`
      + ` · 每天拦截 ${rule.interceptsPerDay}`);
    console.log(`    与其他规则重叠: ${overlap} · 独占抓到 ${rule.incrementalPositives} 个欺诈`);
    for (const drift of rule.drift) {
      console.log(`    特征漂移 ${drift.feature} PSI=${Number.isFinite(drift.psi) ? drift.psi.toFixed(3) : 'n/a'}`);
    }
    if (rule.retune) {
      console.log(`    建议阈值: ${rule.retune.expression}（P=${rule.retune.precision} R=${rule.retune.recall} 命中 ${rule.retune.hits}）`);
    }
    if (rule.retuneGap) console.log(`    阈值无解: ${rule.retuneGap}`);
    console.log(`    判定: ${rule.verdict}${rule.reasons.length > 0 ? `（${rule.reasons.join('；')}）` : ''}`);
  }

  expect('每条规则都有明确的判定', audit.rules.every((rule) => ['keep', 'retune', 'retire'].includes(rule.verdict)));
  expect('判定不是拍脑袋：非 keep 的都带原因',
    audit.rules.filter((rule) => rule.verdict !== 'keep').every((rule) => rule.reasons.length > 0));
  expect('重叠被量化（Jaccard 在 0..1）',
    audit.rules.every((rule) => rule.overlap.every((entry) => entry.jaccard >= 0 && entry.jaccard <= 1)));
  expect('容量（每天拦截次数）被算出来', audit.rules.every((rule) => rule.interceptsPerDay >= 0),
    audit.rules.map((rule) => `${rule.ruleId}:${rule.interceptsPerDay}`).join(', '));
  expect('规则用到的特征都做了漂移检查', audit.rules.every((rule) => rule.drift.length > 0));

  // --- 6. the cost of the recommendation ----------------------------------------------------------
  const after = audit.summary.afterRetire;
  console.log(`[4] 建议: ${audit.recommendation}`);
  console.log(`[6] 如果按建议下线: 剩余召回 ${(after.remainingRecall * 100).toFixed(2)}%，`
    + `少抓 ${after.lostPositives} 个欺诈，每天少 ${after.removedInterceptsPerDay} 次拦截`);
  expect('建议附带"下线代价"，且只算真正会丢的欺诈', after.lostPositives <= audit.window.frauds
  && Number.isFinite(after.remainingRecall),
    `召回 ${after.remainingRecall}, 少抓 ${after.lostPositives}`);
  expect('汇总与逐条判定一致',
    audit.summary.keep + audit.summary.retune + audit.summary.retire === audit.rules.length);

  // --- 7. the guard: a recommendation is not an action --------------------------------------------
  const stillActive = run("SELECT rule_id, status FROM risk_rule ORDER BY rule_id").rows
    .map((row) => `${row.rule_id}:${row.status}`).join(', ');
  console.log(`[7] 数据库里的规则状态: ${stillActive}`);
  expect('Agent 没有改动任何规则状态', /:active/.test(stillActive) && !/:retired|:draft/.test(stillActive));

  // --- skills -------------------------------------------------------------------------------------
  const store = new SkillStore(join(workspace, 'skills'));
  const tips = audit.rules
    .filter((rule) => rule.verdict !== 'keep')
    .map((rule) => store.harvest({
      scope: { agent: 'risk', shape: 'rule-audit' },
      kind: 'check',
      statement: `${rule.ruleId}（${rule.expression}）建议 ${rule.verdict}：${rule.reasons.join('；')}；`
        + `下线会少抓 ${rule.incrementalPositives} 个独占欺诈、每天少 ${rule.interceptsPerDay} 次拦截`,
      rationale: '规则库会腐烂：重叠、漂移、精确率下降，都需要用 holdout 数据定期复核',
      applies: { keywords: ['risk', 'rule', rule.ruleId] },
      evidence: [{
        runId: `audit:${audit.window.to}:${rule.ruleId}`,
        kind: 'plan',
        detail: `audit ${rule.ruleId}: P=${rule.precision} hits=${rule.hits} overlap=${rule.overlap.map((entry) => entry.jaccard).join('/')}`,
        metrics: {
          precision: rule.precision, hits: rule.hits, interceptsPerDay: rule.interceptsPerDay,
          incrementalPositives: rule.incrementalPositives, jaccard: rule.overlap[0]?.jaccard ?? 0,
        },
      }],
      confidence: 0.75,
      createdBy: 'risk-audit-agent',
      now,
    }));
  console.log(`\n[6] 经验: 沉淀 ${tips.length} 条 tip（每条带 P/命中/重叠/容量）`);
  expect('非 keep 的规则都沉淀成 tip', tips.length === audit.rules.filter((rule) => rule.verdict !== 'keep').length);

  // --- artifacts ----------------------------------------------------------------------------------
  const report = `# 风控规则巡检报告（${audit.window.from} ~ ${audit.window.to}）

窗口：${audit.window.events} 个事件 / ${audit.window.frauds} 个欺诈 / ${audit.window.days} 天；判定门槛：精确率 ≥ ${spec.gates.minPrecision}、漂移 PSI > ${spec.gates.driftThreshold}。

| 规则 | 表达式 | 命中 | 精确率 | 召回 | 覆盖 | 每天拦截 | 独占欺诈 | 与其他重叠 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${audit.rules.map((rule) => `| ${rule.ruleId} | \`${rule.expression}\` | ${rule.hits} | ${rule.precision} | ${rule.recall} | ${(rule.coverage * 100).toFixed(2)}% | ${rule.interceptsPerDay} | ${rule.incrementalPositives} | ${rule.overlap.map((entry) => `${entry.ruleId} ${(entry.jaccard * 100).toFixed(0)}%`).join('、') || '—'} | **${rule.verdict}**${rule.retune ? `（建议阈值 \`${rule.retune.expression}\`，P=${rule.retune.precision} R=${rule.retune.recall}）` : ''} |`).join('\n')}

## 建议
${audit.recommendation}

## 如果照做
- 剩余召回：**${(after.remainingRecall * 100).toFixed(2)}%**（会少抓 ${after.lostPositives} 个欺诈）
- 每天少拦截 **${after.removedInterceptsPerDay}** 次（人工审核成本下降，误杀也随之减少）
- **这是建议，不是动作**：规则状态没有改动，下线需要风控负责人确认并留下审批记录。

## 边界
${audit.limits.map((limit) => `- ${limit}`).join('\n')}
`;
  writeArtifact(workspace, 'recommendation.md', report);
  writeFileSync(join(workspace, 'artifacts', 'recommendation.md'), report);
  writeArtifact(workspace, 'audit.json', audit);
  writeArtifact(workspace, 'skills.json', tips.map((tip) => ({ id: tip.id, statement: tip.statement })));
  console.log(`\n产物: ${join(workspace, 'artifacts')}（${spec.outputs.join(', ')}）`);
  console.log(`\n${report.split('\n').slice(0, 10).join('\n')}`);
  finish('风控策略巡检 Agent');
} finally {
  close();
}
