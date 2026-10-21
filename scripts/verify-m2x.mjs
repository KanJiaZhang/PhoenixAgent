#!/usr/bin/env node
/**
 * M2.6 acceptance: cross-fact metrics, and the domain boundary that keeps the model clean.
 *
 * The claim: a metric defined over **two fact tables** is answered without the fan-out that a join would cause,
 * filtered correctly on each side, and refused where it cannot be sliced. Concretely:
 *
 * 1. `capture_rate = gmv / revenue` resolves to a cross-fact ratio with both facts as sources, and the model
 *    also says which dimensions it can be sliced by (only the ones both sides share).
 * 2. The domain scope keeps the risk tables out, so `is_fraud` never becomes a "dimension" of the ad model.
 * 3. The number equals `gmv_by_region / revenue_by_region` computed by hand - and each side is filtered by its
 *    own date column for the requested window.
 * 4. The join does not duplicate: row counts match the numerator's own grouping, and that side's per-slice sum
 *    equals its plain total.
 * 5. A ratio's slices do not add up: the answer's total is the whole-window ratio and the limits say so.
 * 6. It is not served before a person accepts it, and the attribution loop decomposes it exactly into its two
 *    sides (residual 0).
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkClose, checkEqual, section, summary } from './verify-lib.mjs';
import { sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { indexModel, renderCrossFact } from '../packages/semantic/src/sql.ts';
import { ask, translate } from '../packages/semantic/src/ask/index.ts';
import { build } from '../packages/semantic/src/pipeline.ts';
import { ReviewLog, applyRevisions } from '../packages/semantic/src/review.ts';
import { attribute } from '../packages/agents/attribution/src/index.ts';

const root = process.cwd();
const workspace = join(root, '.pag-m2x');
const fixtures = join(root, 'fixtures', 'demo');
const graph = 'demo-analytics';
const nowIso = '2026-10-30T00:00:00.000Z';
rmSync(workspace, { recursive: true, force: true });
build({ fixtures, graph, workspace, now: nowIso });

const stored = JSON.parse(readFileSync(join(workspace, 'build', graph, 'candidates.json'), 'utf8'));
const db = new DatabaseSync(join(fixtures, 'data', 'demo.db'), { readOnly: true });
const runner = sqliteRunner(db, { rowLimit: 1000, timeoutMs: 10_000 });
const run = (sql) => {
  assertReadOnly(sql);
  return runner(sql);
};
const scalar = (sql) => Number(run(sql).rows[0]?.v ?? 0);

// ---------------------------------------------------------------------------------------------------
section('1. the document definition becomes a cross-fact metric');
const capture = stored.candidates.find((candidate) => candidate.id === 'metric/capture_rate');
check('the metric exists', capture !== undefined);
checkEqual('it is a ratio', capture?.payload.metricKind, 'ratio');
checkEqual('the numerator is the order fact', capture?.payload.crossFact?.numerator, 'metric/gmv');
checkEqual('the denominator is the ad fact', capture?.payload.crossFact?.denominator, 'metric/revenue');
check('both source tables are recorded', JSON.stringify(capture?.payload.tables?.sort()) === JSON.stringify(['fact_ad_daily', 'fact_order']),
  JSON.stringify(capture?.payload.tables));
check('it is not additive and says so', capture?.payload.additive === false);
check('it waits for review rather than being served unreviewed', capture?.status === 'needs_review', capture?.status);
const derivedSlices = stored.candidates
  .filter((candidate) => candidate.relationType === 'groupedBy' && candidate.from === 'metric/capture_rate')
  .map((candidate) => candidate.to);
check('the shared dimensions are the only slices it advertises',
  derivedSlices.sort().join(',') === 'dim/industry,dim/region', derivedSlices.join(', '));

// ---------------------------------------------------------------------------------------------------
section('2. the domain scope keeps the other domain out');
const report = JSON.parse(readFileSync(join(workspace, 'build', graph, 'report.json'), 'utf8'));
checkEqual('the model has the ad domain only', report.entities.table.total, 7);
check('no risk table leaked in', !stored.candidates.some((candidate) =>
  candidate.id.includes('risk_event') || candidate.id.includes('feature_snapshot')));
check('no risk "dimension" leaked in', !stored.candidates.some((candidate) => candidate.id === 'dim/is_fraud'),
  stored.candidates.filter((candidate) => candidate.entityType === 'dimension').map((candidate) => candidate.id).join(', '));
check('the report says what was excluded and why', report.notes.some((note) => /scope: 排除/.test(note)),
  report.notes.filter((note) => /scope/.test(note)).join(' | '));

// ---------------------------------------------------------------------------------------------------
section('3. the number is gmv / revenue, computed by hand');
const window = { from: '2025-11-01', to: '2025-12-01' };
const rendered = renderCrossFact(indexModel(stored.candidates), 'metric/capture_rate', ['dim/region'], { period: window });
check('the SQL aggregates each side before joining', /FROM \(SELECT[\s\S]+\) n JOIN \(SELECT[\s\S]+\) d ON/.test(rendered.sql),
  rendered.sql.slice(0, 90));
checkEqual('it does not join the two fact tables', /fact_order[\s\S]*JOIN fact_ad_daily/.test(rendered.sql.split('JOIN (SELECT')[0] ?? ''), false);

const expectedRows = run(`
  SELECT r.region_name AS region,
         (SELECT SUM(o.amount - o.refund_amount) FROM fact_order o
           WHERE o.region_id = r.region_id AND o.status = 'paid'
             AND o.order_date >= '2025-11-01' AND o.order_date < '2025-12-01')
         /
         NULLIF((SELECT SUM(f.revenue) FROM fact_ad_daily f
           WHERE f.region_id = r.region_id
             AND f.date_key >= '2025-11-01' AND f.date_key < '2025-12-01'), 0) AS v
  FROM dim_region r ORDER BY r.region_name`).rows;
const actual = run(rendered.sql).rows;
checkEqual('one row per region, no duplication', actual.length, expectedRows.length);
check('every region matches the hand-written ratio',
  expectedRows.every((row, index) => Math.abs(Number(actual[index]?.value ?? -1) - Number(row.v)) < 1e-9),
  expectedRows.map((row, index) => `${row.region}: ${row.v?.toFixed(6)} vs ${Number(actual[index]?.value).toFixed(6)}`).join(' | '));
check('the values are ratios in (0, 1)', actual.every((row) => Number(row.value) > 0 && Number(row.value) < 1),
  actual.map((row) => Number(row.value).toFixed(5)).join(', '));

// the numerator side, aggregated independently, must sum to the same gmv
const crossSum = scalar('SELECT SUM(value) AS v FROM (' + rendered.sides[0].from + ')');
const gmvTotal = scalar(`SELECT SUM(amount - refund_amount) AS v FROM fact_order
  WHERE status = 'paid' AND order_date >= '2025-11-01' AND order_date < '2025-12-01'`);
checkClose('the numerator side sums to gmv for the window', crossSum, gmvTotal, 1e-9);
const adSum = scalar('SELECT SUM(value) AS v FROM (' + rendered.sides[1].from + ')');
const revenueTotal = scalar(`SELECT SUM(revenue) AS v FROM fact_ad_daily
  WHERE date_key >= '2025-11-01' AND date_key < '2025-12-01'`);
checkClose('the denominator side sums to revenue for the window', adSum, revenueTotal, 1e-9);

// ---------------------------------------------------------------------------------------------------
section('4. the gate: not served before review, served after');
const unreviewed = indexModel(stored.candidates);
const refused = ask({ question: '2025年11月各大区捕获率', index: unreviewed, run });
checkEqual('an unreviewed metric is refused', refused.refusals?.[0]?.code, 'unvalidated');
check('the refusal points at the review step', /审查|采纳/.test(refused.refusals?.[0]?.hint ?? ''),
  refused.refusals?.[0]?.hint);

new ReviewLog(join(workspace, 'reviews', `${graph}.jsonl`)).append({
  ts: nowIso, actor: 'analyst@demo', action: 'accept', target: 'metric/capture_rate', reason: '口径已核对（gmv/revenue）',
});
const reviewed = indexModel(applyRevisions(stored.candidates, new ReviewLog(join(workspace, 'reviews', `${graph}.jsonl`)).all()));
const answered = ask({ question: '2025年11月各大区捕获率', index: reviewed, run });
check('after review it answers', answered.answer !== undefined, JSON.stringify(answered.refusals));
checkEqual('with four regions', answered.answer?.rows.length, 4);

// ---------------------------------------------------------------------------------------------------
section('5. a ratio is not additive, and the answer says so');
const sliceSum = answered.answer.rows.reduce((sum, row) => sum + row.measure, 0);
const overall = scalar(`SELECT (SELECT SUM(amount - refund_amount) FROM fact_order
    WHERE status = 'paid' AND order_date >= '2025-11-01' AND order_date < '2025-12-01')
  / NULLIF((SELECT SUM(revenue) FROM fact_ad_daily
    WHERE date_key >= '2025-11-01' AND date_key < '2025-12-01'), 0) AS v`);
checkClose('the total is the whole-window ratio, not the sum of slices', answered.answer.total, overall, 1e-9);
check('the sum of slices is different, which is why the total is not it', Math.abs(sliceSum - overall) > 1e-6,
  `sum ${sliceSum.toFixed(4)} vs overall ${overall.toFixed(4)}`);
check('the limits say the rows are not additive', answered.limits.some((limit) => /不可加/.test(limit)), answered.limits.join(' | '));
check('the provenance names both sides', JSON.stringify(answered.provenance.metricExpression) === JSON.stringify('metric/gmv / metric/revenue'),
  String(answered.provenance.metricExpression));

// ---------------------------------------------------------------------------------------------------
section('6. a dimension only one side has is refused, with the shared ones named');
const badDim = translate({
  question: '2025年11月各渠道捕获率', index: reviewed, now: new Date(nowIso),
});
checkEqual('slicing by channel is refused', badDim.refusals[0]?.code, 'no-such-dimension');
check('the refusal lists the shared dimensions', /region/.test(badDim.refusals[0]?.hint ?? '')
  && /industry/.test(badDim.refusals[0]?.hint ?? ''), badDim.refusals[0]?.hint);
const forced = translate({
  spec: { metric: 'metric/capture_rate', dimensions: ['dim/channel'], descending: true, matched: [] },
  index: reviewed,
});
check('forcing it through the renderer is a refusal, not a silent drop',
  forced.refusals[0]?.code === 'not-in-model' && /shared:/.test(forced.refusals[0]?.message ?? ''),
  forced.refusals[0]?.message);

// ---------------------------------------------------------------------------------------------------
section('7. the attribution decomposes it exactly into its two sides');
const attribution = attribute({
  metric: 'capture_rate', from: '2025-10', to: '2025-11', index: reviewed, run, mode: 'drivers',
});
checkEqual('the decomposition is the ratio one', attribution.root.decomposition, 'ratio');
checkEqual('the two drivers are the two facts', attribution.root.drivers.map((driver) => driver.metric).sort().join(','),
  'metric/gmv,metric/revenue');
const effects = attribution.root.drivers.reduce((sum, driver) => sum + driver.contribution, 0);
checkClose('the effects add up to the change', effects, attribution.root.delta, 1e-9);
check('the exact decomposition leaves no residual',
  attribution.root.unexplained !== null && Math.abs(attribution.root.unexplained.absolute) <= 1e-9,
  JSON.stringify(attribution.refusals[0]?.message ?? attribution.root.unexplained));

// ---------------------------------------------------------------------------------------------------
section('8. the same question gives the same number');
const again = ask({ question: '2025年11月各大区捕获率', index: reviewed, run });
checkClose('the total is identical', again.answer.total, answered.answer.total, 1e-12);
checkEqual('the SQL is identical', again.plan.sql[0], answered.plan.sql[0]);
check('the window is applied to both sides',
  /fact_order"[\s\S]*2025-11-01[\s\S]*fact_ad_daily"[\s\S]*2025-11-01/.test(answered.plan.sql[0]),
  answered.plan.sql[0].slice(0, 120));

summary('M2.6');
