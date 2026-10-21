#!/usr/bin/env node
/**
 * P1-c acceptance: the decision layer grows the three things that stop a rule stack from working in practice.
 *
 * | addition | claim | attack |
 * | --- | --- | --- |
 * | rule-set analysis | duplication, coverage holes and action conflicts are visible, and marginals add up | a duplicated rule must read `duplicate`, an empty rule `unreachable`, and no fraud may be counted twice |
 * | review capacity | "how many reviewers for this rule set" is arithmetic | more staff must not wait longer, and a saturated queue must be refused, not estimated |
 * | dual approval | two signatures are two *people* | the same actor signing twice must throw, and the published list must wait |
 * | write-back | the plan that leaves the agent is the plan that was approved | the idempotency key must survive reordering but not a changed number; validation must catch a hand-edited payload |
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { check, checkClose, checkEqual, section, summary } from './verify-lib.mjs';
import { sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { analyseRuleSet } from '../packages/agents/risk/src/conflicts.ts';
import { capacityPlan, erlangC } from '../packages/agents/risk/src/capacity.ts';
import { RiskApprovals } from '../packages/agents/risk/src/agent.ts';
import { buildWriteback, validateWriteback, submitWriteback, dryRunAdapter } from '../packages/agents/campaign/src/writeback.ts';

const dbPath = 'fixtures/demo/data/demo.db';
if (!existsSync(dbPath)) {
  console.log(`missing ${dbPath}; run npm run demo:db first`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const run = (sql) => {
  assertReadOnly(sql);
  return sqliteRunner(db, { rowLimit: 100_000, timeoutMs: 20_000 })(sql);
};

// ---------------------------------------------------------------------------------------------------
section('1. the rule set is a system: duplicates, holes and conflicts');
const featureRows = run(`SELECT event_id, feature_name, value FROM feature_snapshot
  WHERE feature_name IN ('f_new_device_flag', 'f_login_fail_7d', 'f_blacklist_hit', 'model_score_v1')`).rows;
const byEvent = new Map();
for (const row of featureRows) {
  const entry = byEvent.get(String(row.event_id)) ?? {};
  entry[String(row.feature_name)] = Number(row.value);
  byEvent.set(String(row.event_id), entry);
}
const events = run(`SELECT event_id, event_date, amount, is_fraud FROM risk_event
  WHERE event_date >= '2025-07-01' ORDER BY event_date, event_id`).rows.map((row) => ({
  id: String(row.event_id),
  date: String(row.event_date),
  window: 'holdout',
  label: Number(row.is_fraud) === 1 ? 1 : 0,
  features: byEvent.get(String(row.event_id)) ?? {},
  fields: { amount: Number(row.amount) },
}));

const rules = [
  { ruleId: 'R001', expression: 'amount >= 5000 AND f_new_device_flag = 1' },
  { ruleId: 'R002', expression: 'f_login_fail_7d >= 3' },
  // the same predicate as R001 with its conditions in the other order: a duplicate, not a new control
  { ruleId: 'R001-dup', expression: 'f_new_device_flag = 1 AND amount >= 5000' },
  // a strict subset of R002: every event it fires on, R002 fires on too
  { ruleId: 'R002-tight', expression: 'f_login_fail_7d >= 6' },
  // an action conflict with R002 on the events both catch
  { ruleId: 'R002-review', expression: 'f_login_fail_7d >= 3', action: 'review' },
  // fires on nothing in this window
  { ruleId: 'R-unreachable', expression: 'f_login_fail_7d >= 900' },
];
const analysis = analyseRuleSet({ events, rules });
checkEqual('the window is the same one the audit used', analysis.window.events, 3757);
check('duplicates are named, not guessed', analysis.duplicates.some((pair) => `${pair.a}/${pair.b}` === 'R001/R001-dup'),
  analysis.duplicates.map((pair) => `${pair.a}/${pair.b}@${pair.jaccard}`).join(', '));
check('a duplicate that also contradicts is both a duplicate and a conflict',
  analysis.duplicates.some((pair) => `${pair.a}/${pair.b}` === 'R002/R002-review')
  && analysis.pairs.find((pair) => pair.a === 'R002' && pair.b === 'R002-review').actionConflict === true,
  'same predicate, different action');
check('a duplicated rule is a merge, not a keep',
  analysis.rules.find((rule) => rule.ruleId === 'R001-dup').verdict === 'merge',
  analysis.rules.find((rule) => rule.ruleId === 'R001-dup').reasons.join('; '));
const subsetPair = analysis.pairs.find((pair) => pair.a === 'R002' && pair.b === 'R002-tight');
check('a rule whose hits are inside another is a superset relation', subsetPair?.relation === 'superset',
  `${subsetPair?.a}/${subsetPair?.b}: ${subsetPair?.relation} (onlyB ${subsetPair?.onlyB})`);
const disjointPair = analysis.pairs.find((pair) => pair.a === 'R001' && pair.b === 'R002-tight');
check('and two rules that never co-fire are disjoint', disjointPair?.relation === 'disjoint', `both ${disjointPair?.both}`);
const conflict = analysis.pairs.find((pair) => pair.actionConflict);
check('two actions on the same events is a conflict', conflict !== undefined,
  `${conflict?.a}/${conflict?.b} on ${conflict?.both} events`);
checkEqual('an unreachable rule is flagged', analysis.unreachable.length, 1);
checkEqual('and it is the one that fires on nothing', analysis.unreachable[0], 'R-unreachable');
check('the union covers more than any single rule',
  analysis.union.frauds >= Math.max(...analysis.rules.map((rule) => rule.frauds)),
  `union ${analysis.union.frauds}/${analysis.window.frauds} (${analysis.union.recall})`);
check('marginal coverage never exceeds the union (no double counting)', analysis.additivity.exact,
  `lone sum ${analysis.additivity.loneSum} vs union ${analysis.additivity.unionFrauds}`);
check('R001 and R002 barely overlap: 1 shared hit on 3,757 events',
  analysis.pairs.find((pair) => pair.a === 'R001' && pair.b === 'R002').both === 1,
  `both ${analysis.pairs.find((pair) => pair.a === 'R001' && pair.b === 'R002').both}`);
const matrixSymmetric = analysis.matrix.every((row, index) => row.every((value, column) => value === analysis.matrix[column][index]));
check('the overlap matrix is symmetric and its diagonal is each rule\'s hits', matrixSymmetric
  && analysis.matrix[0][0] === analysis.rules[0].hits, `${analysis.matrix[0][0]} = ${analysis.rules[0].hits}`);

section('2. capacity is arithmetic, and the queue refuses to be optimistic');
const light = capacityPlan({ hitsPerDay: 40, minutesPerReview: 12, reviewers: 3 });
const heavy = capacityPlan({ hitsPerDay: 400, minutesPerReview: 12, reviewers: 3 });
check('a light queue clears', light.utilisation < 1 && light.meetsSla, `utilisation ${light.utilisation}, SLA ${light.serviceLevel}`);
check('the same team on ten times the volume does not', heavy.verdict === 'understaffed' || !heavy.meetsSla,
  `${heavy.verdict}, utilisation ${heavy.utilisation}`);
check('an overloaded queue is refused rather than given a finite wait', heavy.utilisation >= 1 ? !Number.isFinite(heavy.waitHours) : true,
  `wait ${heavy.waitHours}`);
// 200 cases/day x 12 minutes = 5 erlangs: 6 reviewers sit at 83% utilisation, 7 at 71% - the Erlang cliff
const six = capacityPlan({ hitsPerDay: 200, minutesPerReview: 12, reviewers: 6 });
const seven = capacityPlan({ hitsPerDay: 200, minutesPerReview: 12, reviewers: 7 });
check('more reviewers never wait longer', seven.waitHours <= six.waitHours, `${six.waitHours}h vs ${seven.waitHours}h`);
check('the wait falls faster than linearly near saturation (the Erlang cliff)', six.waitHours / Math.max(seven.waitHours, 1e-9) > 1.5,
  `${six.waitHours}h -> ${seven.waitHours}h, ratio ${(six.waitHours / Math.max(seven.waitHours, 1e-9)).toFixed(2)}x`);
check('the minimum headcount to meet the SLA is computed, not assumed', six.requiredReviewers !== null && six.requiredReviewers <= 20,
  `${six.requiredReviewers} reviewers for ${six.input.hitsPerDay}/day, utilisation ${six.utilisation}`);
checkClose('Erlang-C at zero load is zero', erlangC(0, 5), 0, 0.001);
checkClose('Erlang-C at full load is one', erlangC(5, 5), 1, 0.001);
check('Erlang-C is between them in between', erlangC(3, 5) > 0 && erlangC(3, 5) < 1, `${erlangC(3, 5).toFixed(4)}`);
check('the limit is stated with the model', light.limits.some((limit) => limit.includes('Erlang-C')));

section('3. two signatures are two people');
const workspace = '.pag-p1dec';
rmSync(workspace, { recursive: true, force: true });
const approvals = new RiskApprovals(workspace, 'demo-risk', { quorum: 2 });
approvals.sign('R-NEW-09', 'f_blacklist_hit = 1', 'approve', 'risk-lead@demo', 'first signature', '2026-10-26T00:00:00.000Z');
let thrown = null;
try {
  approvals.sign('R-NEW-09', 'f_blacklist_hit = 1', 'approve', 'risk-lead@demo', 'second try', '2026-10-26T00:01:00.000Z');
} catch (error) {
  thrown = error;
}
check('the same person cannot sign twice', thrown !== null && /already approved/.test(thrown.message), thrown?.message ?? 'no error');
checkEqual('one signature is not a decision', approvals.state('R-NEW-09').decision, null);
checkEqual('and nothing is published yet', approvals.decisions().size, 0);
approvals.sign('R-NEW-09', 'f_blacklist_hit = 1', 'approve', 'risk-head@demo', 'second signature', '2026-10-26T00:02:00.000Z');
checkEqual('two distinct signatures are', approvals.state('R-NEW-09').decision, 'approve');
checkEqual('and the rule is published', approvals.decisions().size, 1);
check('with both names on it', approvals.decisions().get('R-NEW-09').actor.includes('risk-lead@demo')
  && approvals.decisions().get('R-NEW-09').actor.includes('risk-head@demo'),
  approvals.decisions().get('R-NEW-09').actor);
const single = new RiskApprovals(workspace, 'single', { quorum: 1 });
single.sign('R-X', 'amount >= 1', 'approve', 'one@demo', 'alone');
checkEqual('a quorum of one still works for low-stakes decisions', single.decisions().size, 1);
const rejectFirst = new RiskApprovals(workspace, 'rejects', { quorum: 2 });
rejectFirst.sign('R-Y', 'amount >= 1', 'reject', 'one@demo', 'no');
checkEqual('a rejection is immediate, whatever the quorum', rejectFirst.state('R-Y').decision, 'reject');
rmSync(workspace, { recursive: true, force: true });

section('4. write-back: the approved plan is the plan that leaves');
const allocation = {
  budget: 1000,
  objective: 'revenue',
  cells: [
    { id: 'c1', key: { region: '华东' }, currentSpend: 400, proposedSpend: 500, delta: 100, shareOfBudget: 0.5, currentRoi: 2, marginalRoi: 1.8, expectedRevenueCurrent: 800, expectedRevenueProposed: 940, expectedRevenueDelta: 140, curve: { kind: 'saturating', params: {}, r2: 0.9, points: 12, saturation: 0.5 } },
    { id: 'c2', key: { region: '华北' }, currentSpend: 300, proposedSpend: 250, delta: -50, shareOfBudget: 0.25, currentRoi: 1.5, marginalRoi: 0.9, expectedRevenueCurrent: 450, expectedRevenueProposed: 380, expectedRevenueDelta: -70, curve: { kind: 'saturating', params: {}, r2: 0.9, points: 12, saturation: 0.5 } },
    { id: 'c3', key: { region: '华南' }, currentSpend: 300, proposedSpend: 250, delta: -50, shareOfBudget: 0.25, currentRoi: 1.2, marginalRoi: 0.8, expectedRevenueCurrent: 360, expectedRevenueProposed: 310, expectedRevenueDelta: -50, curve: { kind: 'saturating', params: {}, r2: 0.9, points: 12, saturation: 0.5 } },
  ],
  moves: [],
  iterations: 12,
  boundHit: false,
  totals: {
    currentSpend: 1000, proposedSpend: 1000, expectedRevenueCurrent: 1610, expectedRevenueProposed: 1630,
    expectedRevenueDelta: 20, expectedProfitCurrent: 610, expectedProfitProposed: 630, expectedProfitDelta: 20,
    improvementPct: 0.0124, noise: 12,
  },
};
const plan = buildWriteback(allocation, { platform: 'demo-ads', effectiveFrom: '2026-11-01', budget: 1000, maxChangePct: 0.5, now: '2026-10-26T00:00:00.000Z' });
checkEqual('every cell is in the payload, including the ones left alone', plan.cells.length, 3);
check('the totals are the plan\'s, rounded to cents', plan.totals.proposedSpend === 1000 && plan.budget === 1000,
  `${plan.totals.proposedSpend} / ${plan.budget}`);
check('the budget check passes', plan.checks.every((check) => check.ok), plan.checks.filter((entry) => !entry.ok).map((entry) => entry.detail).join('; '));
check('there are no validation issues against its own plan', validateWriteback(plan, allocation, { budget: 1000, maxChangePct: 0.5 }).length === 0,
  JSON.stringify(validateWriteback(plan, allocation, { budget: 1000, maxChangePct: 0.5 })));

const reordered = buildWriteback({ ...allocation, cells: [...allocation.cells].reverse() }, { platform: 'demo-ads', effectiveFrom: '2026-11-01', budget: 1000, maxChangePct: 0.5 });
checkEqual('reordering the cells does not change the idempotency key', reordered.idempotencyKey, plan.idempotencyKey);

const tweaked = buildWriteback({ ...allocation, cells: allocation.cells.map((cell) => cell.id === 'c1' ? { ...cell, proposedSpend: 501 } : cell) }, { platform: 'demo-ads', effectiveFrom: '2026-11-01', budget: 1001, maxChangePct: 0.5 });
check('one yuan of difference is a different request', tweaked.idempotencyKey !== plan.idempotencyKey, `${plan.idempotencyKey} vs ${tweaked.idempotencyKey}`);

const handEdited = { ...plan, cells: plan.cells.map((cell) => cell.cell === 'c1' ? { ...cell, proposedSpend: 999 } : cell) };
const editedIssues = validateWriteback(handEdited, allocation, { budget: 1000, maxChangePct: 0.5 });
check('a hand-edited payload is caught', editedIssues.length > 0, editedIssues.map((issue) => issue.code).join(', '));
check('both the number and the key are checked', editedIssues.some((issue) => issue.code === 'total-mismatch' || issue.code === 'bound-violated'),
  editedIssues.map((issue) => `${issue.code}:${issue.detail}`).join(' | '));

const overBound = buildWriteback({ ...allocation, cells: allocation.cells.map((cell) => cell.id === 'c1' ? { ...cell, proposedSpend: 900 } : cell), budget: 1250 }, { platform: 'demo-ads', effectiveFrom: '2026-11-01', budget: 1250, maxChangePct: 0.5 });
check('a move beyond the bound is a failed check', overBound.checks.some((entry) => !entry.ok), overBound.checks.filter((entry) => !entry.ok).map((entry) => entry.detail).join('; '));

const dry = await submitWriteback(plan, dryRunAdapter('demo-ads'), { now: '2026-10-26T00:00:00.000Z' });
checkEqual('the default is a dry run', dry.status, 'dry-run');
const committed = await submitWriteback(plan, { ...dryRunAdapter('demo-ads'), commit: async () => ({ receiptId: 'rcpt-1', acceptedAt: '2026-10-26T00:00:01.000Z' }) }, { commit: true });
checkEqual('commit is explicit', committed.status, 'committed');
check('and it carries a receipt', committed.receiptId === 'rcpt-1', committed.receiptId ?? '');
const rejected = await submitWriteback(handEdited, dryRunAdapter('demo-ads'));
checkEqual('an invalid payload never reaches the adapter', rejected.status, 'rejected');

section('5. determinism');
const again = analyseRuleSet({ events, rules });
checkEqual('same analysis twice', JSON.stringify(again.pairs), JSON.stringify(analysis.pairs));

summary('P1-c decision platform');
