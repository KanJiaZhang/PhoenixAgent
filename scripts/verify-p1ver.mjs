#!/usr/bin/env node
/**
 * P1-b acceptance: a semantic model can now be released on evidence instead of on hope.
 *
 * The claim is that a revision can be graded *before* it is published, and that the grading is mechanical:
 *
 * | claim | attack |
 * | --- | --- |
 * | changes are classified by what they move, not by how big they look | a one-character expression change must read as breaking; a description edit must not |
 * | removals are graded by their consumers | deleting a column that a dimension and three metrics read must name them |
 * | the warehouse is the reference, not the model | drift is measured against `PRAGMA table_info`, never against our own claims |
 * | the numbers are shown, not assumed | a 10% inflation of `spend` must surface as a shadow diff of about 10% and hold the release |
 * | a compatible change promotes without ceremony | adding a metric must not require a shadow run |
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkClose, checkEqual, section, summary } from './verify-lib.mjs';
import { readSqliteCatalog, sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { build } from '../packages/semantic/src/pipeline.ts';
import { diffModels, driftReport, shadowAsk, releaseGate } from '../packages/semantic/src/version.ts';

const root = process.cwd();
const workspace = join(root, '.pag-p1ver');
const fixtures = join(root, 'fixtures', 'demo');
const graph = 'demo-analytics';
const now = new Date('2026-10-29T00:00:00.000Z');
rmSync(workspace, { recursive: true, force: true });
if (!existsSync(join(workspace, 'build', graph, 'candidates.json'))) {
  build({ fixtures, graph, workspace, now: now.toISOString() });
}
const candidates = JSON.parse(readFileSync(join(workspace, 'build', graph, 'candidates.json'), 'utf8')).candidates;

const db = new DatabaseSync(join(fixtures, 'data', 'demo.db'), { readOnly: true });
const runner = sqliteRunner(db, { rowLimit: 1000, timeoutMs: 10_000 });
const run = (sql) => {
  assertReadOnly(sql);
  return runner(sql);
};
const clone = () => structuredClone(candidates);
const find = (list, id) => list.find((candidate) => candidate.id === id);

section('1. a model against itself is empty, and that is the baseline the rest is measured from');
const self = diffModels(candidates, clone());
checkEqual('no changes', self.changes.length, 0);
checkEqual('verdict is compatible', self.verdict, 'compatible');
checkEqual('counts agree', JSON.stringify(self.from.counts), JSON.stringify(self.to.counts));

section('2. classification is by what a change moves, not by how big it is');
const inflated = clone();
find(inflated, 'metric/spend').payload.expression = '(SUM(fact_ad_daily.spend) * 1.1)';
const expressionDiff = diffModels(candidates, inflated, { from: 1, to: 2 });
const expressionChange = expressionDiff.changes.find((change) => change.id === 'metric/spend' && change.field === 'expression');
check('a one-line expression edit is breaking', expressionChange?.compatibility === 'breaking', expressionChange?.reason ?? 'not found');
check('and the release verdict follows', expressionDiff.verdict === 'breaking', `verdict ${expressionDiff.verdict}`);

const described = clone();
find(described, 'metric/spend').payload.description = `${find(described, 'metric/spend').payload.description ?? ''}（补充说明）`;
const describedDiff = diffModels(candidates, described);
check('a description edit is not a breaking change', describedDiff.verdict !== 'breaking', describedDiff.verdict);

const rebind = clone();
find(rebind, 'dim/region').payload.column = 'column/fact_ad_daily.industry_id';
const rebindDiff = diffModels(candidates, rebind);
const rebindChange = rebindDiff.changes.find((change) => change.id === 'dim/region');
check('a dimension rebind is behavioural, not breaking', rebindChange?.compatibility === 'behavioural', rebindChange?.reason ?? 'not found');

const added = clone();
added.push({ ...structuredClone(find(added, 'metric/spend')), id: 'metric/spend_v2', payload: { ...structuredClone(find(added, 'metric/spend').payload), name: 'spend_v2' } });
const addedDiff = diffModels(candidates, added);
check('a new metric is compatible', addedDiff.verdict === 'compatible', addedDiff.verdict);
checkEqual('and it is counted as added', addedDiff.summary.added, 1);

section('3. a removal is graded by who reads it');
const removed = clone().filter((candidate) => candidate.id !== 'column/fact_ad_daily.region_id');
const removedDiff = diffModels(candidates, removed);
const removal = removedDiff.changes.find((change) => change.kind === 'removed');
check('removing a column with consumers is breaking', removal?.compatibility === 'breaking', removal?.reason ?? 'not found');
check('and the consumers are named, not summarised', (removal?.consumers ?? []).length >= 3,
  (removal?.consumers ?? []).slice(0, 4).join(', '));
check('the consumers really are the things that read it', (removal?.consumers ?? []).some((consumer) => consumer.startsWith('dim/')),
  (removal?.consumers ?? []).join(', '));

const orphan = clone().filter((candidate) => candidate.id !== 'metric/spend_v2' && candidate.id !== 'metric/cac');
const orphanDiff = diffModels(candidates, orphan);
check('removing things nobody reads is behavioural, not breaking', orphanDiff.verdict === 'behavioural', orphanDiff.verdict);

section('4. drift is measured against the warehouse, and the demo warehouse is in sync');
// The catalog reader is the same one the profile stage uses; PRAGMA never goes through the read-only guard (it is
// the guard's job to refuse it), so the schema read uses the connection directly, exactly like production would.
const catalog = readSqliteCatalog(db, 'demo.db');
const live = catalog.tables.map((table) => ({ name: table.name, columns: table.columns.map((column) => ({ name: column.name, type: column.dataType })) }));
for (const view of ['ads_region_month']) {
  const columns = db.prepare(`PRAGMA table_info(${view})`).all().map((row) => ({ name: String(row.name), type: String(row.type) }));
  if (columns.length > 0) live.push({ name: view, columns });
}
const inSync = driftReport(candidates, live);
checkEqual('no blocking drift on the demo warehouse', inSync.blocking, 0);
check('and it actually checked something', inSync.checked.columns > 20, `${inSync.checked.tables} tables, ${inSync.checked.columns} columns`);

const droppedColumn = structuredClone(live).map((table) => table.name === 'fact_ad_daily'
  ? { ...table, columns: table.columns.filter((column) => column.name !== 'spend') }
  : table);
const droppedReport = driftReport(candidates, droppedColumn);
check('a column missing from the warehouse is blocking', droppedReport.verdict === 'drift' && droppedReport.blocking > 0,
  droppedReport.issues.filter((issue) => issue.blocking).map((issue) => issue.target).join(', '));

const retyped = structuredClone(live).map((table) => table.name === 'fact_ad_daily'
  ? { ...table, columns: table.columns.map((column) => column.name === 'spend' ? { ...column, type: 'TEXT' } : column) }
  : table);
const retypedReport = driftReport(candidates, retyped);
check('a type change is drift, not a warning', retypedReport.issues.some((issue) => issue.kind === 'type-changed' && issue.blocking),
  retypedReport.issues.filter((issue) => issue.kind === 'type-changed').map((issue) => issue.detail).join(', '));

const extra = structuredClone(live).map((table) => table.name === 'fact_ad_daily'
  ? { ...table, columns: [...table.columns, { name: 'new_column', type: 'TEXT' }] }
  : table);
const extraReport = driftReport(candidates, extra);
check('an unmodelled column is reported but does not block', extraReport.verdict === 'ok' && extraReport.issues.some((issue) => issue.kind === 'new-column'),
  `${extraReport.issues.filter((issue) => issue.kind === 'new-column').length} new columns`);

section('5. shadow mode shows the numbers, so a release can be argued with evidence');
const question = '2025 年 11 月各大区花费';
const identical = shadowAsk({ question, previous: candidates, next: clone(), run, now });
checkEqual('identical revisions promote', identical.verdict, 'promote');
checkEqual('with zero rows moved', identical.comparison.rowsChanged, 0);
check('and the answer is the same four regions', identical.next.rows.length === 4, JSON.stringify(identical.next.rows.map((row) => row.value)));

const inflatedShadow = shadowAsk({ question, previous: candidates, next: inflated, run, now });
checkClose('a 10% inflation shows up as a ~0.1 relative delta', inflatedShadow.comparison.maxRelativeDelta, 0.1, 0.001);
checkEqual('and the release is held', inflatedShadow.verdict, 'hold');

const missing = clone().filter((candidate) => candidate.id !== 'metric/spend');
const refusedShadow = shadowAsk({ question, previous: candidates, next: missing, run, now });
checkEqual('a revision that cannot answer is a hold, not an empty answer', refusedShadow.verdict, 'hold');
check('the refusal code is carried through', refusedShadow.next.refused[0]?.code === 'no-such-metric', refusedShadow.next.refused[0]?.code ?? '');

section('6. the gate combines them, and cannot be talked past');
const gateOk = releaseGate({ diff: self, drift: inSync, shadows: [identical] });
checkEqual('compatible + no drift + identical shadow promotes', gateOk.verdict, 'promote');

const gateDrift = releaseGate({ diff: self, drift: droppedReport });
checkEqual('warehouse drift rejects regardless of the diff', gateDrift.verdict, 'reject');
check('and says why', gateDrift.reasons.some((reason) => reason.includes('drift')), gateDrift.reasons.join('; '));

const gateBreakingNoEvidence = releaseGate({ diff: expressionDiff, drift: inSync });
checkEqual('a breaking diff with no shadow is a hold', gateBreakingNoEvidence.verdict, 'hold');
check('the missing evidence is named', gateBreakingNoEvidence.reasons.some((reason) => reason.includes('no shadow')),
  gateBreakingNoEvidence.reasons.join('; '));

const gateBreakingWithEvidence = releaseGate({ diff: expressionDiff, drift: inSync, shadows: [identical] });
checkEqual('a breaking diff with an identical shadow is still a hold', gateBreakingWithEvidence.verdict, 'hold',
  'the shadow answer did not use the inflated model');
const gateBreakingRealEvidence = releaseGate({ diff: expressionDiff, drift: inSync, shadows: [identical, inflatedShadow] });
checkEqual('any held shadow keeps the hold', gateBreakingRealEvidence.verdict, 'hold');

section('7. determinism');
const again = diffModels(candidates, inflated, { from: 1, to: 2 });
checkEqual('same diff twice', JSON.stringify(again.changes), JSON.stringify(expressionDiff.changes));

rmSync(workspace, { recursive: true, force: true });
summary('P1-b model versioning');
