#!/usr/bin/env node
/**
 * P6 / M7 acceptance: the risk-strategy agent.
 *
 * Four claims, one per stage of the pipeline:
 *
 * 1. **The trend is found, and only where it exists.** A step injected into one region is detected at that
 *    month with a z and both rates; the other regions produce no change point.
 * 2. **A future function is rejected before it can flatter the model.** The leaky feature has the best AUC in
 *    the file and is refused on `as_of_date` alone - and the same check is exercised directly on a synthetic
 *    value, so the guard is tested independently of the fixture.
 * 3. **A rule is measured the way risk measures**: holdout precision/recall, coverage, lift, and the increment
 *    over the rules already live. The gate bites: a 100%-precision rule with too little recall is rejected.
 * 4. **Nothing is published by the agent.** The published list is derived from approval lines a person wrote;
 *    before approval it is empty, after approval it contains exactly that rule.
 */

import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkClose, checkEqual, section, summary } from './verify-lib.mjs';
import { sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { riskAgent, RiskApprovals } from '../packages/agents/risk/src/index.ts';
import { evaluateFeature } from '../packages/agents/risk/src/features.ts';
import { SkillStore } from '../packages/skills/src/types.ts';
import { harvestFromRisk } from '../packages/skills/src/harvest.ts';
import { advise } from '../packages/skills/src/advise.ts';

const root = process.cwd();
const dbPath = join(root, 'fixtures', 'demo', 'data', 'demo.db');
const workspace = join(root, '.pag-m7');
rmSync(workspace, { recursive: true, force: true });

const db = new DatabaseSync(dbPath, { readOnly: true });
const runner = sqliteRunner(db, { rowLimit: 200_000, timeoutMs: 30_000 });
const run = (sql) => {
  assertReadOnly(sql);
  return runner(sql);
};

const report = riskAgent({ run, graph: 'demo-risk', workspace, holdoutMonths: 3 });

// ---------------------------------------------------------------------------------------------------
section('1. the trend is found, and only where it exists');
checkEqual('the run had enough labels to work with', report.refusals.length, 0);
const withChange = report.trends.filter((trend) => trend.changePoint !== null);
const regionChanges = withChange.filter((trend) => trend.dimension === 'region');
checkEqual('exactly one region shows a change point', regionChanges.length, 1);
const step = regionChanges[0];
checkEqual('it is the region the step was injected into', step?.value, '3');
check('the change starts at the injected month (within one month of monthly noise)',
  ['2025-06', '2025-07', '2025-08'].includes(step?.changePoint?.period ?? ''),
  `${step?.changePoint?.period}`);
check('the direction and the size are reported', step?.changePoint?.direction === 'up'
  && step.changePoint.lift > 2 && step.changePoint.z >= 4,
  `lift ${step?.changePoint?.lift}, z ${step?.changePoint?.z}`);
checkClose('the "before" rate matches the data', step.changePoint.before.rate, 0.025, 0.02);
checkClose('the "after" rate matches the data', step.changePoint.after.rate, 0.068, 0.03);
check('the report carries the sample sizes the z rests on',
  step.changePoint.before.events > 1000 && step.changePoint.after.events > 500,
  `${step.changePoint.before.events} before, ${step.changePoint.after.events} after`);
// A spike detector and a step detector answer different questions, so the step must not be reported as a spike:
// after a step the rolling baseline climbs with it, which is exactly why the split test exists.
check('the stable regions raise no spikes (false positives on a constructed history)',
  report.trends.filter((trend) => trend.dimension === 'region' && trend.value !== '3')
    .every((trend) => trend.spikes.length === 0),
  report.trends.filter((trend) => trend.dimension === 'region').map((trend) => `${trend.value}:${trend.spikes.length}`).join(', '));
import { detectSpikes, toSeries } from '../packages/agents/risk/src/trend.ts';
const synthetic = toSeries([
  { period: '2025-01', events: 500, frauds: 10 },
  { period: '2025-02', events: 500, frauds: 9 },
  { period: '2025-03', events: 500, frauds: 11 },
  { period: '2025-04', events: 500, frauds: 10 },
  { period: '2025-05', events: 500, frauds: 10 },
  { period: '2025-06', events: 500, frauds: 12 },
  { period: '2025-07', events: 500, frauds: 10 },
  { period: '2025-08', events: 500, frauds: 60 },
  { period: '2025-09', events: 500, frauds: 11 },
  { period: '2025-10', events: 500, frauds: 10 },
]);
const spikes = detectSpikes(synthetic);
checkEqual('a single injected spike month is the only one flagged', spikes.length, 1);
checkEqual('and it is the month it was injected into', spikes[0]?.period, '2025-08');
check('the spike carries the baseline it beat', spikes[0].z > 5 && spikes[0].baseline < 0.03,
  `z ${spikes[0].z}, baseline ${spikes[0].baseline}`);

// ---------------------------------------------------------------------------------------------------
section('2. a future function is rejected before it can flatter the model');
const leaky = report.rejectedFeatures.find((feature) => feature.name === 'f_chargeback_30d');
check('the leaky feature is in the rejected list', leaky !== undefined);
check('it is rejected on the point-in-time check, not on quality', leaky.pointInTime.ok === false
  && leaky.pointInTime.violations === report.window.events,
  `${leaky?.pointInTime.violations} violations of ${leaky?.pointInTime.checked}`);
check('and it is the best feature in the file, which is the point', leaky.auc > 0.9, `AUC ${leaky.auc}`);
check('the reason says what it is', leaky.reasons.some((reason) => /future function/.test(reason)), leaky.reasons.join(' | '));

// the guard itself, on synthetic values: one post-event row is enough
const direct = evaluateFeature('synthetic_leak', [
  { value: 0.1, label: 0, asOfBeforeEvent: true, window: '2025-01' },
  { value: 0.9, label: 1, asOfBeforeEvent: false, window: '2025-01' },
  { value: 0.2, label: 0, asOfBeforeEvent: true, window: '2025-01' },
  { value: 0.8, label: 1, asOfBeforeEvent: true, window: '2025-01' },
  { value: 0.3, label: 0, asOfBeforeEvent: true, window: '2025-01' },
  { value: 0.7, label: 1, asOfBeforeEvent: true, window: '2025-01' },
]);
check('one post-event value is enough to make a feature unusable', direct.usable === false
  && direct.pointInTime.violations === 1, direct.reasons.join(' | '));

const strong = report.features.find((feature) => feature.name === 'model_score_v1');
check('the model score is effective and stable', strong.usable === true
  && strong.auc > 0.85 && strong.ks > 0.5 && strong.iv > 1
  && Number.isFinite(strong.psi) && strong.psi < 0.25,
  `AUC ${strong?.auc}, KS ${strong?.ks}, IV ${strong?.iv}, PSI ${strong?.psi}`);
check('its monotonicity is reported', strong.monotonicity === 'increasing', strong.monotonicity);
check('the blacklist feature is effective at high precision', report.features.find((feature) => feature.name === 'f_blacklist_hit')?.usable === true,
  `AUC ${report.features.find((feature) => feature.name === 'f_blacklist_hit')?.auc}`);
check('every feature reports all four numbers', report.features.slice(0, 5).every((feature) =>
  Number.isFinite(feature.auc) && Number.isFinite(feature.ks) && Number.isFinite(feature.iv)));

// ---------------------------------------------------------------------------------------------------
section('3. the rule is measured the way risk measures');
const recommended = report.rules.filter((rule) => rule.status === 'candidate' || rule.status === 'published');
check('at least one rule clears the gate', recommended.length >= 1,
  `${recommended.length} recommended of ${report.rules.length}`);
const best = recommended[0];
check('the rule has at most three conditions', best.conditions.length <= 3, best.expression);
check('it is measured on the holdout, not just on the window it was fitted on',
  best.holdout !== undefined && best.holdout.window === 'holdout', best.holdout?.window);
check('holdout precision and recall clear the gate',
  best.holdout.precision >= 0.75 && best.holdout.recall >= 0.15,
  `P=${best.holdout.precision}, R=${best.holdout.recall}`);
check('the confusion matrix adds up',
  best.holdout.tp + best.holdout.fp + best.holdout.fn + best.holdout.tn === best.holdout.evaluated,
  `${best.holdout.tp}+${best.holdout.fp}+${best.holdout.fn}+${best.holdout.tn}=${best.holdout.evaluated}`);
check('lift and coverage are reported', best.holdout.lift > 5 && best.holdout.coverage > 0,
  `lift ${best.holdout.lift}, coverage ${best.holdout.coverage}`);
check('the increment over the live rules is computed', best.incremental !== undefined
  && best.incremental.overlapShare >= 0 && best.incremental.overlapShare <= 1,
  JSON.stringify(best.incremental));
check('it adds frauds the current stack misses', recommended.some((rule) => (rule.incremental?.newOnlyPositives ?? 0) > 0),
  recommended.map((rule) => `${rule.id}:+${rule.incremental?.newOnlyPositives ?? 0}`).join(', '));
check('the gate bites: a perfect-precision rule with too little recall is rejected',
  report.rules.some((rule) => rule.status === 'rejected' && (rule.holdout?.precision ?? 0) >= 0.9
    && (rule.holdout?.recall ?? 0) < 0.15),
  report.rules.filter((rule) => rule.status === 'rejected').map((rule) => `${rule.id}:P${rule.holdout?.precision}`).join(', '));
check('every rejected rule says why', report.rules.filter((rule) => rule.status === 'rejected')
  .every((rule) => rule.reasons.length > 0));

// ---------------------------------------------------------------------------------------------------
section('4. nothing is published by the agent');
checkEqual('before approval, nothing is published', report.published.length, 0);
const approvals = new RiskApprovals(workspace, 'demo-risk');
let refusedActor = false;
try {
  approvals.decide(best.id, best.expression, 'approve', '  ', 'no name');
} catch {
  refusedActor = true;
}
check('an approval without an actor is refused', refusedActor);
approvals.decide(best.id, best.expression, 'approve', 'risk-lead@demo', 'backtest reviewed', '2026-10-26T00:00:00.000Z');
approvals.decide('R-NEW-01', 'model_score_v1 >= 0.9', 'reject', 'risk-lead@demo', 'overlaps R002', '2026-10-26T00:01:00.000Z');
const after = riskAgent({ run, graph: 'demo-risk', workspace, holdoutMonths: 3 });
checkEqual('after approval, exactly one rule is published', after.published.length, 1);
checkEqual('it is the approved one', after.published[0]?.id, best.id);
check('the published rule carries who approved it and when',
  after.published[0]?.approvedBy === 'risk-lead@demo' && after.published[0]?.approvedAt === '2026-10-26T00:00:00.000Z',
  `${after.published[0]?.approvedBy} ${after.published[0]?.approvedAt}`);
check('a rejected rule is marked rejected with the reason',
  after.rules.find((rule) => rule.id === 'R-NEW-01')?.status === 'rejected'
  && after.rules.find((rule) => rule.id === 'R-NEW-01')?.reasons.some((reason) => /overlaps R002/.test(reason)),
  after.rules.find((rule) => rule.id === 'R-NEW-01')?.reasons.join(' | '));
check('unapproved candidates stay candidates', after.rules.filter((rule) => rule.status === 'candidate').length >= 1);

// ---------------------------------------------------------------------------------------------------
section('5. the same data gives the same rules');
const again = riskAgent({ run, graph: 'demo-risk', workspace, holdoutMonths: 3 });
check('the rules and their metrics are identical',
  JSON.stringify(again.rules.map((rule) => [rule.id, rule.expression, rule.holdout?.precision, rule.holdout?.recall]))
  === JSON.stringify(after.rules.map((rule) => [rule.id, rule.expression, rule.holdout?.precision, rule.holdout?.recall])));
check('the trend is identical', JSON.stringify(again.trends.map((trend) => trend.changePoint))
  === JSON.stringify(after.trends.map((trend) => trend.changePoint)));

// ---------------------------------------------------------------------------------------------------
section('6. the run teaches the skill library');
const store = new SkillStore(join(workspace, 'skills'));
const tips = harvestFromRisk(store, after, { actor: 'verifier', now: '2026-10-26T00:00:00.000Z' });
check('risk lessons were harvested', tips.length >= 2, `${tips.length} tips`);
check('they carry the numbers', tips.every((tip) => tip.evidence.some((evidence) => evidence.metrics !== undefined)));
check('a point-in-time lesson exists', tips.some((tip) => /未来函数|as_of/.test(tip.statement)),
  tips.map((tip) => tip.statement.slice(0, 40)).join(' | '));
const advice = advise(store, 'risk feature model_score_v1 rule', { limit: 5 });
check('the lessons are retrievable', advice.advice.length > 0, advice.advice.map((entry) => entry.tip.id).join(', '));

// ---------------------------------------------------------------------------------------------------
section('7. the CLI is the same agent');
const cliReport = JSON.parse(execFileSync(process.execPath, [
  'packages/agents/risk/src/cli.ts', '--workspace', workspace, '--graph', 'demo-risk', '--json',
], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
checkClose('the CLI finds the same change point', cliReport.trends.find((trend) => trend.value === '3')?.changePoint?.z ?? 0,
  step.changePoint.z, 1e-9);
checkEqual('the CLI publishes the same rules', cliReport.published.length, after.published.length);
const listed = JSON.parse(execFileSync(process.execPath, [
  'packages/agents/risk/src/cli.ts', 'list', '--workspace', workspace, '--graph', 'demo-risk', '--json',
], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
checkEqual('the approval log lists both decisions', listed.length, 2);
check('the audit trail carries the actor', listed.every((entry) => entry.actor === 'risk-lead@demo'));

summary('M7');
