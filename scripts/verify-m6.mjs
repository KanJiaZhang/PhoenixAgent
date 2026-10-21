#!/usr/bin/env node
/**
 * P5 / M6 acceptance: the campaign agent.
 *
 * Four claims, and the second is the one that makes the rest worth anything:
 *
 * 1. **The curves are mathematically what they say.** The analytic marginal is compared against a numerical
 *    derivative for every model, and a constant-ROI dataset is classified as linear instead of being given an
 *    invented saturation. (This is not theoretical: the first version of the saturating marginal was off by a
 *    factor of K, which made every saturated cell look worthless and inverted the whole recommendation.)
 * 2. **The plan obeys its constraints and beats doing nothing.** Budget is conserved, per-cell moves stay in
 *    bounds, and the projected gain is larger than the curves' own noise - otherwise the agent refuses.
 * 3. **Every move is explainable to a curve.** Each cell carries its model, parameters, fit and both ROIs.
 * 4. **The plan is falsifiable.** A holdout design with effect size, noise and the sample arithmetic that says
 *    whether it can detect anything.
 */

import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkClose, checkEqual, section, summary } from './verify-lib.mjs';
import { readSqliteCatalog, sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { indexModel } from '../packages/semantic/src/sql.ts';
import { fitResponse, campaign } from '../packages/agents/campaign/src/index.ts';
import { SkillStore } from '../packages/skills/src/types.ts';
import { harvestFromCampaign } from '../packages/skills/src/harvest.ts';
import { advise } from '../packages/skills/src/advise.ts';

const root = process.cwd();
const dbPath = join(root, 'fixtures', 'demo', 'data', 'demo.db');
const workspace = join(root, '.pag');
const graph = 'demo-analytics';
const modelPath = join(workspace, 'build', graph, 'candidates.json');
rmSync(join(root, '.pag-m6'), { recursive: true, force: true });

if (!existsSync(modelPath)) {
  execFileSync(process.execPath, ['packages/semantic/src/cli.ts', 'build', '--graph', graph,
    '--now', '2026-10-25T00:00:00.000Z', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const index = indexModel(JSON.parse(readFileSync(modelPath, 'utf8')).candidates);
const db = new DatabaseSync(dbPath, { readOnly: true });
const runner = sqliteRunner(db, { rowLimit: 100_000, timeoutMs: 20_000 });
const run = (sql) => {
  assertReadOnly(sql);
  return runner(sql);
};

// ---------------------------------------------------------------------------------------------------
section('1. the curve maths hold up');
/** A saturating world: revenue = 6·S/(1+S/100k), sampled over a 10x spend range. */
const saturatingPoints = Array.from({ length: 20 }, (_, index) => {
  const spend = 20_000 * (1 + index * 0.5);
  return { spend, revenue: (6 * spend) / (1 + spend / 100_000) };
});
const saturating = fitResponse(saturatingPoints, { at: 120_000 });
check(['saturating', 'power'].includes(saturating.kind), 'a concave dataset gets a concave model', saturating.kind);
check('the saturating model is recognised as saturated', saturating.saturation < 0.95,
  `marginal/average ${saturating.saturation}`);
/** A linear world: constant ROI must not be given an invented saturation. */
const linearPoints = Array.from({ length: 20 }, (_, index) => {
  const spend = 20_000 * (1 + index * 0.5);
  return { spend, revenue: 2.5 * spend };
});
const linear = fitResponse(linearPoints, { at: 120_000 });
checkEqual('a constant-ROI dataset is classified as linear', linear.kind, 'linear');
checkClose('its marginal equals the average', linear.saturation, 1, 0.02);

/** Analytic marginal vs a central difference: the bug that inverted the first recommendation was here. */
for (const [name, curve] of [['saturating', saturating], ['linear', linear]]) {
  for (const spend of [30_000, 80_000, 200_000]) {
    const h = spend * 1e-4;
    const numerical = (curve.predict(spend + h) - curve.predict(spend - h)) / (2 * h);
    const analytic = curve.marginal(spend);
    const relative = Math.abs(numerical - analytic) / Math.max(Math.abs(numerical), 1e-9);
    check(`${name}: the analytic marginal matches the numerical derivative at ${spend}`,
      relative < 1e-3, `analytic ${analytic.toFixed(6)} vs numerical ${numerical.toFixed(6)}`);
  }
}
check('revenue at zero spend is zero', Math.abs(saturating.predict(0)) < 1e-9);

// ---------------------------------------------------------------------------------------------------
section('2. the plan obeys its constraints and beats the alternative');
const plan = campaign({ run, index });
check('a plan is produced without refusals', plan.refusals.length === 0,
  plan.refusals.map((refusal) => refusal.message).join(' | '));
check('the plan covers the whole grid', plan.cost.cells >= 30, `${plan.cost.cells} cells, ${plan.cost.periods} periods`);
checkEqual('the grid took two queries, not one per cell', plan.cost.queries, 2);

const proposed = plan.cells.reduce((total, cell) => total + cell.proposedSpend, 0);
// rounding each cell to 6 decimals leaves a few millionths of a yuan on a 3.4M budget
checkClose('the budget is conserved', proposed, plan.budget, 1e-3);
check('every move respects the per-cell bound',
  plan.cells.every((cell) => Math.abs(cell.delta) <= cell.currentSpend * 0.5 + 1e-3),
  plan.cells.filter((cell) => Math.abs(cell.delta) > cell.currentSpend * 0.5 + 1e-3)
    .map((cell) => `${cell.id} ${cell.delta}/${cell.currentSpend}`).join(', '));
check('every share is inside the bounds',
  plan.cells.every((cell) => cell.shareOfBudget >= 0.005 - 1e-6 && cell.shareOfBudget <= 0.35 + 1e-6),
  `min ${Math.min(...plan.cells.map((cell) => cell.shareOfBudget))}, max ${Math.max(...plan.cells.map((cell) => cell.shareOfBudget))}`);
check('the projected gain clears the curves’ noise',
  plan.allocation.totals.expectedRevenueDelta > plan.allocation.totals.noise,
  `gain ${plan.allocation.totals.expectedRevenueDelta.toFixed(0)} vs noise ${plan.allocation.totals.noise.toFixed(0)}`);
check('the projected gain is an improvement, and it is a projection',
  plan.allocation.totals.improvementPct > 0 && /预计|模型/.test(plan.explanation),
  `${(plan.allocation.totals.improvementPct * 100).toFixed(2)}%`);
check('the budget is unchanged while the revenue is projected higher',
  Math.abs(plan.allocation.totals.proposedSpend - plan.allocation.totals.currentSpend) < 1e-3
  && plan.allocation.totals.expectedRevenueProposed > plan.allocation.totals.expectedRevenueCurrent,
  `spend ${plan.allocation.totals.currentSpend} -> ${plan.allocation.totals.proposedSpend}`);
check('both directions are recommended', plan.cells.some((cell) => cell.delta > 0) && plan.cells.some((cell) => cell.delta < 0),
  `increases ${plan.cells.filter((cell) => cell.delta > 0).length}, decreases ${plan.cells.filter((cell) => cell.delta < 0).length}`);
const receivers = plan.cells.filter((cell) => cell.delta > 0).map((cell) => cell.marginalRoi);
const donors = plan.cells.filter((cell) => cell.delta < 0).map((cell) => cell.marginalRoi);
const meanOf = (values) => values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);
check('money moves from low marginal return to high', meanOf(receivers) > meanOf(donors) * 1.5,
  `receivers avg ${meanOf(receivers).toFixed(2)} vs donors avg ${meanOf(donors).toFixed(2)}`);
const spreadBefore = Math.max(...plan.cells.map((cell) => cell.marginalRoi)) - Math.min(...plan.cells.map((cell) => cell.marginalRoi));
const spreadAfter = Math.max(...plan.cells.map((cell) => cell.marginalRoiAfter)) - Math.min(...plan.cells.map((cell) => cell.marginalRoiAfter));
// With ±50% bounds the marginals cannot be fully equalised, so the claim is "narrower", not "equal": the
// unconstrained optimum is further out and the agent says so.
check('the plan narrows the marginal spread, which is what equalising means', spreadAfter < spreadBefore,
  `${spreadBefore.toFixed(2)} -> ${spreadAfter.toFixed(2)}`);

// ---------------------------------------------------------------------------------------------------
section('3. every move is explainable to a curve');
check('each cell carries its model, parameters and fit',
  plan.cells.every((cell) => ['saturating', 'power', 'linear'].includes(cell.curve.kind)
    && Object.keys(cell.curve.params).length >= 1 && cell.curve.r2 >= 0 && cell.curve.points >= 5),
  JSON.stringify(plan.cells[0]?.curve));
const medianR2 = plan.cells.map((cell) => cell.curve.r2).sort((a, b) => a - b)[Math.floor(plan.cells.length / 2)];
check('the median fit is good', medianR2 >= 0.8, `median r² ${medianR2}`);
check('the curves say the world is concave', plan.cells.filter((cell) => cell.curve.kind !== 'linear')
  .every((cell) => cell.curve.saturation < 1), `max saturation ${Math.max(...plan.cells.map((cell) => cell.curve.saturation))}`);
check('the narrative explains the model on an example cell', /r²=/.test(plan.explanation) && /边际 ROI/.test(plan.explanation));
check('the narrative never promises an outcome', !/保证|一定能|必然/.test(plan.explanation), plan.explanation.slice(0, 120));
check('the limits say the gain is a projection, not a realised one',
  plan.limits.some((limit) => /外推|预测/.test(limit)) && plan.limits.some((limit) => /因果/.test(limit)),
  plan.limits.join(' | '));

// ---------------------------------------------------------------------------------------------------
section('4. the plan is falsifiable');
const holdout = plan.holdout;
check('a holdout is proposed, with a treatment and a control', holdout.design === 'geoholdout'
  && holdout.treatment.length > 0 && holdout.control.length > 0,
  `${holdout.design}: ${holdout.treatment} vs ${holdout.control}`);
check('it states the effect it must detect and the noise it must beat',
  holdout.effectSize > 0 && holdout.noise >= 0, `effect ${holdout.effectSize}, noise ${holdout.noise}`);
check('the sample arithmetic is consistent with the feasibility verdict',
  holdout.feasible === (holdout.requiredUnitsPerArm <= holdout.availableUnits),
  `required ${holdout.requiredUnitsPerArm}, available ${holdout.availableUnits}, feasible ${holdout.feasible}`);
check('the note says what to do when it cannot be run, or how to run it',
  holdout.feasible ? /拆分|对照/.test(holdout.note) : /延长|合并/.test(holdout.note), holdout.note.slice(0, 120));
check('the horizon is stated in weeks', holdout.horizonWeeks > 0, `${holdout.horizonWeeks} weeks`);

// ---------------------------------------------------------------------------------------------------
section('5. refusals instead of a plan that cannot be justified');
const missing = campaign({ run, index, spendMetric: 'metric/not_a_metric' });
checkEqual('a missing 口径 metric refuses', missing.refusals[0]?.code, 'not-in-model');
check('the refusal names the missing metric', /not_a_metric/.test(missing.refusals[0]?.message ?? ''),
  missing.refusals[0]?.message);
const insaneBudget = campaign({ run, index, budget: 10 * (plan.budget) });
checkEqual('a budget outside the per-cell bounds refuses', insaneBudget.refusals[0]?.code, 'budget',
  insaneBudget.refusals[0]?.message);
const frozen = campaign({ run, index, maxChangePct: 0 });
checkEqual('a plan that cannot move anything is not recommended', frozen.refusals[0]?.code, 'unvalidated',
  frozen.refusals[0]?.message);

// ---------------------------------------------------------------------------------------------------
section('6. the same data gives the same plan');
const again = campaign({ run, index });
checkClose('the projected gain is identical', again.allocation.totals.expectedRevenueDelta,
  plan.allocation.totals.expectedRevenueDelta, 1e-9);
check('the moves are identical',
  JSON.stringify(again.cells.map((cell) => [cell.id, cell.delta])) === JSON.stringify(plan.cells.map((cell) => [cell.id, cell.delta])));
check('the SQL is identical', JSON.stringify(again.evidence.sql) === JSON.stringify(plan.evidence.sql));

// ---------------------------------------------------------------------------------------------------
section('7. the plan teaches the skill library');
const store = new SkillStore(join(root, '.pag-m6', 'skills'));
const tips = harvestFromCampaign(store, plan, { actor: 'verifier', now: '2026-10-25T00:00:00.000Z' });
check('at least two lessons were harvested', tips.length >= 2, `${tips.length} tips`);
check('every lesson carries numbers', tips.every((tip) => tip.evidence.some((evidence) => evidence.metrics !== undefined)));
check('a marginal-ROI lesson exists', tips.some((tip) => /边际 ROI/.test(tip.statement)),
  tips.map((tip) => tip.statement.slice(0, 40)).join(' | '));
const advice = advise(store, 'campaign budget curve 直播 3C数码', { limit: 5 });
check('the lessons are retrievable', advice.advice.length > 0, advice.advice.map((entry) => entry.tip.id).join(', '));

// ---------------------------------------------------------------------------------------------------
section('8. the CLI is the same agent');
const cli = JSON.parse(execFileSync(process.execPath, [
  'packages/agents/campaign/src/cli.ts', '--graph', graph, '--workspace', workspace, '--json',
], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
checkClose('the CLI projects the same gain', cli.allocation.totals.expectedRevenueDelta,
  plan.allocation.totals.expectedRevenueDelta, 1e-9);
check('the CLI carries the same number of cells', cli.cells.length === plan.cells.length, `${cli.cells.length}`);
check('the CLI carries the grid SQL as evidence', cli.evidence.sql.length === 2, `${cli.evidence.sql.length}`);

summary('M6');
