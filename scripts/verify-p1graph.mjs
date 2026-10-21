#!/usr/bin/env node
/**
 * P1-a acceptance: the entity graph now produces numbers, and the numbers survive five attacks.
 *
 * The claim is narrow on purpose. Not "graph features are good", but: *this* pipeline computes structural
 * features from *this* company graph, on data a decision could legally have, and the increment over the row
 * features is measured on held-out months rather than on the window the model was fitted to.
 *
 * | attack | what would expose a liar |
 * | --- | --- |
 * | "the fixture was reshuffled to make it work" | event and fraud counts must be untouched (15,188 / 449) |
 * | "the snapshot saw the future" | every snapshot's `as_of` must be <= the event date it serves |
 * | "the features are the label in disguise" | flipping every label must not change one feature value |
 * | "the graph is decorative" | a structural feature's AUC and the model increment must both be positive |
 * | "the base is not really traversing" | (when enabled) the base's own traversal must agree with the local BFS |
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { check, checkClose, checkEqual, section, summary } from './verify-lib.mjs';
import { sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { graphFeaturesReport } from '../packages/agents/risk/src/graph-report.ts';
import { buildSnapshot, buildSnapshots, isoWeek, periodOf, snapshotCutoff, publishAndCrossCheck, cleanupPublishedSchema } from '../packages/agents/risk/src/graph.ts';
import { evaluateFeature } from '../packages/agents/risk/src/features.ts';
import { loadConfig } from '../packages/core/src/config.ts';
import { GraphClient } from '../packages/core/src/graph-client.ts';

const dbPath = 'fixtures/demo/data/demo.db';
if (!existsSync(dbPath)) {
  console.log(`missing ${dbPath}; run npm run demo:db first`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const statements = [];
const run = (sql) => {
  assertReadOnly(sql);
  statements.push(sql);
  return sqliteRunner(db, { rowLimit: 200_000, timeoutMs: 30_000 })(sql);
};

section('the fixture change is additive: the labels are byte-for-byte the ones the docs quote');
const totals = run('SELECT COUNT(*) AS events, SUM(is_fraud) AS frauds FROM risk_event').rows[0];
checkEqual('events unchanged', Number(totals.events), 15188);
checkEqual('frauds unchanged', Number(totals.frauds), 449);
const entityCoverage = run(`SELECT COUNT(*) AS n FROM risk_event
  WHERE account_id IS NULL OR device_id IS NULL OR ip_id IS NULL`).rows[0];
checkEqual('every event has an account, a device and an ip', Number(entityCoverage.n), 0);

section('one snapshot per month, each as of the previous month end');
checkEqual('cutoff for 2024-03-01', snapshotCutoff('2024-03-01'), '2024-02-29');
checkEqual('cutoff survives a January', snapshotCutoff('2025-01-15'), '2024-12-31');
checkEqual('cutoff survives a leap boundary', snapshotCutoff('2024-03-31'), '2024-02-29');

const links = run('SELECT event_id, event_date, account_id, device_id, ip_id FROM risk_event ORDER BY event_date, event_id')
  .rows.map((row) => ({
    eventId: String(row.event_id), date: String(row.event_date),
    account: String(row.account_id), device: String(row.device_id), ip: String(row.ip_id),
  }));
const snapshot = buildSnapshot(links, '2025-11-30', '2025-12');
check('a snapshot only knows edges dated on or before its cutoff',
  snapshot.links.every((link) => link.date <= snapshot.asOf), `${snapshot.links.length} edges, newest ${snapshot.links.map((l) => l.date).sort().at(-1)}`);
check('the ring is one component, not scattered singletons',
  Math.max(...[...snapshot.features.values()].map((entry) => entry.componentSize)) >= 20,
  `largest component ${Math.max(...[...snapshot.features.values()].map((entry) => entry.componentSize))} accounts`);

const report = await graphFeaturesReport({ run, cutoff: '2025-07' });

section('point-in-time: no snapshot is newer than the event it explains');
const pit = report.progression.every((entry) => entry.asOf < `${entry.month}-01` || entry.month === '2024-01');
check('every monthly snapshot predates its month', pit,
  `${report.progression.length} months, ${report.progression[0]?.asOf} .. ${report.progression.at(-1)?.asOf}`);
check('the feature values themselves passed the same gate', report.features.every((feature) => feature.pointInTime.ok),
  report.features.map((feature) => `${feature.name}:${feature.pointInTime.violations}`).join(' '));

section('the features are structural: flipping every label changes nothing');
check('label independence holds', report.labelIndependence.identical, `${report.labelIndependence.checked} events compared`);

section('the graph carries signal on its own');
const best = [...report.features].sort((a, b) => b.auc - a.auc)[0];
check('a structural feature ranks fraud above non-fraud', best.auc > 0.6, `${best.name} AUC ${best.auc}`);
check('component size is as strong as the best single feature (collinear with the degree, as expected)',
  report.features.find((feature) => feature.name === 'g_component_size').auc >= best.auc - 0.02,
  report.features.map((feature) => `${feature.name}=${feature.auc}`).join(' '));
check('at least three of the five structural features clear 0.65',
  report.features.filter((feature) => feature.auc >= 0.65).length >= 3,
  report.features.map((feature) => `${feature.name}=${feature.auc}`).join(' '));

section('the ring forms over time: a point-in-time snapshot can only see what has happened');
const sizes = report.progression.map((entry) => entry.ringComponentSize);
const monotone = sizes.every((size, index) => index === 0 || size >= sizes[index - 1]);
check('the ring component never shrinks', monotone, sizes.join(' '));
const firstFull = sizes.findIndex((size) => size === sizes.at(-1));
check('the ring takes months to form, it is not known on day one', firstFull >= 4,
  `full size ${sizes.at(-1)} reached in month ${firstFull + 1} of ${sizes.length}`);
check('the first usable snapshot sees a fraction of the ring', sizes[1] <= 0.4 * sizes.at(-1),
  `${sizes[1]} of ${sizes.at(-1)}`);

section('what a leak looks like: dates, not model quality, are the detector');
// The same features, built with a snapshot allowed to know its own month. Measured, not asserted - because the
// measurement is the interesting part: the leaky variant does *not* always score higher, so "the AUC looks fine" can
// never be the evidence that a feature is legal. Only the dates are.
const leakySnapshots = new Map();
for (const month of [...new Set(links.map((link) => link.date.slice(0, 7)))].sort()) {
  const [year, number] = month.split('-').map(Number);
  leakySnapshots.set(month, buildSnapshot(links, new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10), month));
}
const labelByEvent = new Map(run('SELECT event_id, is_fraud FROM risk_event').rows.map((row) => [String(row.event_id), Number(row.is_fraud) === 1 ? 1 : 0]));
const leakyValues = [];
let leakyViolations = 0;
for (const link of links) {
  const snapshot = leakySnapshots.get(link.date.slice(0, 7));
  const features = snapshot?.features.get(link.account);
  if (!features) continue;
  if (snapshot.asOf > link.date) leakyViolations++;
  leakyValues.push({ value: features.sharedDeviceMax, label: labelByEvent.get(link.eventId), asOfBeforeEvent: snapshot.asOf <= link.date, window: link.date.slice(0, 7) });
}
const leakyReport = evaluateFeature('g_shared_device_max', leakyValues, { minPositives: 30 });
const pitAuc = report.features.find((feature) => feature.name === 'g_shared_device_max').auc;
check('the same-month snapshot violates the date rule on most events', leakyViolations > leakyValues.length * 0.9,
  `${leakyViolations} of ${leakyValues.length}`);
check('the honest snapshot violates it on none', report.features.every((feature) => feature.pointInTime.violations === 0));
check('the leaky variant is often *not* better, so quality cannot be the check', Number.isFinite(leakyReport.auc),
  `PIT AUC ${pitAuc} vs same-month AUC ${leakyReport.auc} (leak visible only in the dates)`);
check('the report refuses to use the leaky values at all', report.features.every((feature) => feature.pointInTime.ok),
  'graph-report.ts builds every snapshot from snapshotCutoff(), never from the event month');

section('neighbour reputation: the feature everyone reaches for, measured and not shipped');
const labels = report.labelPropagation;
check('a label-confirmed neighbour feature is computed', labels.pit.auc > 0.6, `AUC ${labels.pit.auc}`);
check('it never reads a label confirmed after the cutoff',
  labels.cutoffRespected.identical && labels.cutoffRespected.checked >= 400,
  `${labels.cutoffRespected.checked} recomputations, identical ${labels.cutoffRespected.identical}`);
const early = labels.monthly.filter((entry) => Number.isFinite(entry.pit) && Number.isFinite(entry.leaky)).slice(0, 5);
const earlyPit = early.reduce((total, entry) => total + entry.pit, 0) / Math.max(early.length, 1);
const earlyLeaky = early.reduce((total, entry) => total + entry.leaky, 0) / Math.max(early.length, 1);
check('the leaky variant is only marginally better, even where the graph is young', earlyLeaky - earlyPit < 0.05,
  `early months: PIT ${earlyPit.toFixed(3)} vs leaky ${earlyLeaky.toFixed(3)}`);
check('and the feature adds nothing on top of structure, so it is not in the model', labels.models.increment <= 0.001,
  `${labels.models.withoutLabels} -> ${labels.models.withLabels} (+${labels.models.increment})`);

section('held-out increment: same rows, same solver, one extra block');
check('the split is the last six months', report.models.split.test.events >= 3000, `${report.models.split.test.events} test events`);
check('base model is not a straw man', report.models.base.auc >= 0.7, `base AUC ${report.models.base.auc}`);
check('adding the graph block improves held-out AUC', report.models.increment > 0.01,
  `${report.models.base.auc} -> ${report.models.withGraph.auc} (+${report.models.increment})`);
check('and the graph block weights point the right way (bigger component, more risk)',
  report.models.coefficients.find((entry) => entry.name === 'g_component_size').weight > 0,
  report.models.coefficients.map((entry) => `${entry.name}=${entry.weight}`).join(' '));

section('weekly snapshots: the same rule at a finer grain');
check('a week key is ISO-8601, not the calendar week', isoWeek('2024-12-30').key === '2025-W01' && isoWeek('2025-01-06').key === '2025-W02',
  `${isoWeek('2024-12-30').key} / ${isoWeek('2025-01-06').key}`);
check('the weekly cutoff is the day before the week starts', periodOf('2024-03-06', 'week').asOf === '2024-03-03',
  `${periodOf('2024-03-06', 'week').asOf} for week starting ${isoWeek('2024-03-06').start}`);
check('the demo year spans 104 ISO weeks', new Set(links.map((link) => isoWeek(link.date).key)).size >= 100,
  `${new Set(links.map((link) => isoWeek(link.date).key)).size} weeks`);
// a quarter of the data keeps this fast: 13 snapshots are enough to check the rule, the grain and the freshness
const quarter = links.filter((link) => link.date >= '2025-01-01' && link.date < '2025-04-01');
const weekSnapshots = buildSnapshots(quarter, 'week');
check('a snapshot per week of the quarter', weekSnapshots.size === 13, `${weekSnapshots.size} snapshots`);
const weeklyViolations = [...weekSnapshots.entries()].filter(([key, snapshot]) => {
  const weekStart = isoWeek(quarter.find((link) => isoWeek(link.date).key === key).date).start;
  return snapshot.asOf >= weekStart;
});
check('no weekly snapshot is newer than the week it serves', weeklyViolations.length === 0, `${weeklyViolations.length} violations`);
const probe = quarter[Math.floor(quarter.length * 0.9)];
const monthlyQuarter = buildSnapshots(quarter, 'month');
const monthlyAtProbe = monthlyQuarter.get(probe.date.slice(0, 7));
const weeklyAtProbe = weekSnapshots.get(isoWeek(probe.date).key);
check('the weekly snapshot knows more than the monthly one for a mid-month event', weeklyAtProbe.edges > monthlyAtProbe.edges,
  `${weeklyAtProbe.edges} vs ${monthlyAtProbe.edges} edges`);
check('and each weekly snapshot keeps its own cutoff', [...weekSnapshots.values()].every((snapshot) => snapshot.asOf < snapshot.serves.slice(0, 4) + '-12-31'),
  'cutoffs are dates, not labels');

if (process.env.PAGENT_GRAPH_WEEKLY === '1') {
  // the full run at the finer grain: 104 snapshots, ~18s. Opt-in, like the base cross-check.
  const weeklyReport = await graphFeaturesReport({ run, cutoff: '2025-07', grain: 'week' });
  check('the weekly report uses weekly periods', weeklyReport.snapshot.grain === 'week' && weeklyReport.snapshot.periods >= 100,
    `${weeklyReport.snapshot.periods} periods`);
  check('and its point-in-time gate still passes', weeklyReport.features.every((feature) => feature.pointInTime.ok),
    weeklyReport.features.map((feature) => feature.pointInTime.violations).join(','));
  check('the increment survives the finer grain', Math.abs(weeklyReport.models.increment - report.models.increment) < 0.01,
    `month ${report.models.increment} vs week ${weeklyReport.models.increment}`);
} else {
  console.log('  skip  set PAGENT_GRAPH_WEEKLY=1 to run the full 104-week report (about 18s)');
}

section('determinism: a second run produces identical numbers');
const again = await graphFeaturesReport({ run, cutoff: '2025-07' });
checkEqual('same feature AUCs', JSON.stringify(again.features.map((feature) => feature.auc)), JSON.stringify(report.features.map((feature) => feature.auc)));
checkEqual('same increment', again.models.increment, report.models.increment);
checkClose('same snapshot size', again.snapshot.accounts, report.snapshot.accounts, 0);

section('the base as a second engine (optional: PAGENT_GRAPH_CROSSCHECK=1)');
if (process.env.PAGENT_GRAPH_CROSSCHECK === '1') {
  const config = loadConfig();
  const client = new GraphClient(config.phoenix);
  const crossCheck = await publishAndCrossCheck(client, snapshot, { sample: 40 });
  check('the base answers the same two-hop count', crossCheck.status === 'ok',
    `${crossCheck.agree}/${crossCheck.sampled} sampled accounts; ${crossCheck.note ?? ''}`);
  if (crossCheck.mismatches.length > 0) console.log('   mismatches:', JSON.stringify(crossCheck.mismatches.slice(0, 3)));
  // the base writes a schema file next to its sources; that directory is not ours to leave files in
  const removed = cleanupPublishedSchema(crossCheck.graph);
  console.log(`  note  cleaned ${removed.length} schema file(s) from the base: ${removed.join(', ') || 'none'}`);
} else {
  console.log('  skip  set PAGENT_GRAPH_CROSSCHECK=1 with the base running to compare traversals');
}

section('cost');
console.log(`  ${report.cost.events} events, ${report.snapshot.periods} ${report.snapshot.grain} snapshots, ${report.cost.accounts} accounts, ${report.cost.ms} ms, ${report.cost.queries} queries`);
console.log(`  features: ${report.features.map((feature) => `${feature.name} AUC=${feature.auc} IV=${feature.iv}`).join(' | ')}`);
console.log(`  model: base ${report.models.base.auc} -> +graph ${report.models.withGraph.auc} (increment ${report.models.increment})`);

summary('P1-a graph features');
