#!/usr/bin/env node
/**
 * P2 / M3 acceptance: the shared SQL layer.
 *
 * Four claims, and the third is the one that keeps the layer honest:
 *
 * 1. **The rules fire on the shapes they name.** Constructed queries for P01, P02, P03, P04, P06 and P13 each
 *    produce their finding, and a clean query produces none.
 * 2. **Every applied rewrite is result-preserving.** The original and the rewritten SQL are both executed on
 *    the demo warehouse and their rows compared - not the plan, the answers.
 * 3. **The evidence is measured.** The month-prefix rewrite turns `SCAN fact_order` into
 *    `SEARCH ... USING INDEX`, and the comparison reports it; comparing a plan with itself reports *no*
 *    improvement rather than a green tick.
 * 4. **The step ledger is a ledger.** Apply, hand-edit, revert all replay to the same SQL, and a suggestion
 *    (a `LIMIT`, which changes the answer) is refused when somebody tries to apply it.
 */

import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkEqual, section, summary } from './verify-lib.mjs';
import { readSqliteCatalog } from '../packages/dataplane/src/sqlite.ts';
import { analyze, proposeRewrites, explain, compareEvidence } from '../packages/sqllayer/src/analyze.ts';
import { SqlWorkspace } from '../packages/sqllayer/src/steps.ts';

const root = process.cwd();
const dbPath = join(root, 'fixtures', 'demo', 'data', 'demo.db');
const workspaceDir = join(root, '.pag-m3');
rmSync(workspaceDir, { recursive: true, force: true });

const db = new DatabaseSync(dbPath, { readOnly: true });
const catalog = readSqliteCatalog(db, dbPath);

// sorted: the same rows are the same answer, and an index legitimately changes the order they arrive in
const rows = (sql) => db.prepare(sql).all().map((row) => JSON.stringify(row)).sort();

// ---------------------------------------------------------------------------------------------------
section('1. the rules fire on the shapes they name');
const cases = [
  ['P01', 'SELECT * FROM fact_order', {}],
  ['P02', "SELECT COUNT(*) FROM fact_ad_daily WHERE region_id = 1", { rowCountThreshold: 100 }],
  ['P03', "SELECT order_id FROM fact_order WHERE substr(order_date, 1, 7) = '2024-05'", {}],
  ['P04', "SELECT order_id FROM fact_order WHERE status = 'paid' OR region_id = 2", { rowCountThreshold: 100 }],
  ['P06', 'SELECT o.order_id, r.region_name FROM fact_order o, dim_region r', { rowCountThreshold: 100 }],
  ['P13', 'SELECT order_id FROM fact_order', {}],
];
for (const [rule, sql, options] of cases) {
  const findings = analyze(sql, { catalog, ...options });
  check(`${rule} is detected`, findings.some((finding) => finding.rule === rule),
    findings.map((finding) => finding.rule).join(', ') || 'no findings');
}
const clean = analyze("SELECT o.order_id FROM fact_order o JOIN dim_region r ON o.region_id = r.region_id "
  + "WHERE o.order_date >= '2024-05-01' AND o.order_date < '2024-06-01' LIMIT 10", { catalog });
check('a well-formed query produces no findings', clean.length === 0,
  clean.map((finding) => finding.rule).join(', '));

// ---------------------------------------------------------------------------------------------------
section('2. every applied rewrite is result-preserving');
const equivalence = [
  "SELECT order_id, amount FROM fact_order WHERE substr(order_date, 1, 7) = '2024-05'",
  "SELECT order_id FROM fact_order WHERE substr(order_date, 1, 4) = '2025'",
  "SELECT o.order_id, o.amount FROM fact_order o WHERE substr(o.order_date, 1, 7) = '2025-11'",
  "SELECT COUNT(*) AS n FROM fact_order WHERE substr(order_date, 1, 7) = '2024-12'",
];
for (const sql of equivalence) {
  const steps = proposeRewrites(sql, { catalog }).filter((step) => step.kind === 'rewrite');
  if (steps.length === 0) {
    check(`a rewrite is offered for: ${sql.slice(0, 46)}`, false, 'no step proposed');
    continue;
  }
  const rewritten = steps[steps.length - 1].sqlAfter;
  checkEqual(`same rows after the rewrite: ${sql.slice(0, 44)}...`, JSON.stringify(rows(rewritten)),
    JSON.stringify(rows(sql)));
}

// P01 with a required-column list: the projection shrinks, the values do not
const projectionSql = "SELECT * FROM fact_ad_daily WHERE date_key >= '2024-05-01' AND date_key < '2024-06-01'";
const projectionSteps = proposeRewrites(projectionSql, { catalog, requiredColumns: ['date_key', 'spend', 'revenue'] })
  .filter((step) => step.rule === 'P01');
check('P01 is rewritten when the caller says which columns it needs', projectionSteps.length === 1,
  projectionSteps[0]?.sqlAfter.slice(0, 70));
if (projectionSteps.length === 1) {
  const rewritten = projectionSteps[0].sqlAfter;
  const original = rows(projectionSql).map((row) => JSON.stringify({
    date_key: JSON.parse(row).date_key, spend: JSON.parse(row).spend, revenue: JSON.parse(row).revenue,
  })).sort();
  checkEqual('the projected columns are unchanged by P01', JSON.stringify(rows(rewritten)), JSON.stringify(original));
}

// ---------------------------------------------------------------------------------------------------
section('3. the evidence is measured, and "no improvement" is said out loud');
const monthSql = "SELECT * FROM fact_order WHERE substr(order_date, 1, 7) = '2024-05'";
const monthSteps = proposeRewrites(monthSql, { catalog }).filter((step) => step.kind === 'rewrite');
const before = explain(db, monthSql);
const after = explain(db, monthSteps[0].sqlAfter);
check('the original scans the table', before.fullScans.includes('fact_order'), before.plan.join(' | '));
check('the rewrite searches an index', after.indexSearches.some((search) => search.index === 'idx_fact_order_date'),
  after.plan.join(' | '));
checkEqual('both sides return the same number of rows', after.rows, before.rows);
const comparison = compareEvidence(before, after);
check('the comparison claims an improvement, with the reason', comparison.improved && comparison.changed.length > 0,
  comparison.changed.join('; '));
check('comparing a plan with itself reports no improvement',
  compareEvidence(before, before).improved === false, JSON.stringify(compareEvidence(before, before)));

// ---------------------------------------------------------------------------------------------------
section('4. the step ledger: apply, edit, revert, replay');
const workspace = new SqlWorkspace(workspaceDir);
const plan = workspace.plan(monthSql, { catalog, dbPath, actor: 'verifier' });
check('the plan records its steps and evidence', plan.steps.length >= 1 && plan.before !== undefined && plan.after !== undefined,
  `${plan.steps.length} step(s), comparison ${JSON.stringify(plan.comparison?.changed)}`);
checkEqual('the rewrite is a rewrite, not a suggestion',
  plan.steps.find((step) => step.rule === 'P03')?.kind, 'rewrite');

const applied = workspace.apply(plan.id, plan.steps[0].seq, 'verifier', '2026-10-21T00:00:00.000Z');
checkEqual('applying a step yields its SQL', applied.sql, plan.steps[0].sqlAfter);

const editedSql = "SELECT order_id, amount FROM fact_order WHERE order_date >= '2024-05-01' AND order_date < '2024-06-01'";
workspace.edit(plan.id, editedSql, 'analyst@demo', 'trimmed the projection by hand', '2026-10-21T00:01:00.000Z');
const stateAfterEdit = workspace.state(plan.id);
checkEqual('a human edit becomes the current SQL', stateAfterEdit.current, editedSql);
check('the edit is attributed, not silent',
  stateAfterEdit.history.some((entry) => entry.action === 'edit' && entry.actor === 'analyst@demo'),
  stateAfterEdit.history.map((entry) => `${entry.seq}:${entry.action}`).join(' → '));

workspace.revert(plan.id, plan.steps[0].seq, 'analyst@demo', '2026-10-21T00:02:00.000Z');
const stateAfterRevert = workspace.state(plan.id);
checkEqual('reverting restores the pre-rewrite SQL', stateAfterRevert.current, plan.original);
checkEqual('the replay ends where the log says it does', stateAfterRevert.current,
  stateAfterRevert.history[stateAfterRevert.history.length - 1].sql);
check('the ledger keeps every action, in order',
  stateAfterRevert.history.map((entry) => entry.action).join(',') === 'plan,apply,edit,revert',
  stateAfterRevert.history.map((entry) => entry.action).join(','));

// a suggestion is offered but cannot be applied: a LIMIT changes the answer
const suggestionPlan = workspace.plan('SELECT order_id FROM fact_order', { catalog, dbPath, actor: 'verifier' });
const suggestion = suggestionPlan.steps.find((step) => step.kind === 'suggestion');
check('an unbounded query gets a LIMIT suggestion', suggestion !== undefined, suggestion?.rationale ?? 'none');
let refused = false;
try {
  workspace.apply(suggestionPlan.id, suggestion.seq, 'verifier');
} catch (error) {
  refused = /suggestion/.test(error.message);
}
check('the workbench refuses to apply a suggestion', refused);

// ---------------------------------------------------------------------------------------------------
section('5. the CLI is the same layer');
const cli = JSON.parse(execFileSync(process.execPath, [
  'packages/sqllayer/src/cli.ts', 'plan', '--sql', monthSql, '--workspace', workspaceDir, '--json',
], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
check('the CLI plans a query with steps and evidence', cli.steps.length >= 1 && cli.before?.plan?.length > 0,
  `${cli.steps.length} step(s), before plan ${cli.before?.plan?.join(' | ')}`);

summary('M3');
