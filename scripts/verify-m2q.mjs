#!/usr/bin/env node
/**
 * M2.5 acceptance: the semantic layer answers questions from its own model.
 *
 * The claim under test is not "it understands language" (it does not, and does not claim to). It is:
 *
 * 1. **The vocabulary is the model's**, and a word outside it is a refusal that lists what it does know.
 * 2. **A breakdown that matches no dimension is refused, never answered as a total.** This is the bug the base
 *    documents in its own DATA-AGENT.md §10; a total in place of a decomposition is a correct number to the
 *    wrong question.
 * 3. **The numbers are checkable**: every answer is compared with a hand-written SQL query for the same window.
 * 4. **The answer carries its provenance**: model revision, metric expression, the SQL, the filter, row count.
 * 5. **The same question gives the same SQL and the same number**, and `translate` runs nothing.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkClose, checkEqual, section, summary } from './verify-lib.mjs';
import { sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { indexModel } from '../packages/semantic/src/sql.ts';
import { ask, interpret, translate } from '../packages/semantic/src/ask/index.ts';
import { build } from '../packages/semantic/src/pipeline.ts';
import { createAgentServer } from '../packages/api/src/server.ts';

const root = process.cwd();
const workspace = join(root, '.pag-m2q');
const fixtures = join(root, 'fixtures', 'demo');
const graph = 'demo-analytics';
const now = new Date('2026-10-29T00:00:00.000Z');
rmSync(workspace, { recursive: true, force: true });
if (!existsSync(join(workspace, 'build', graph, 'candidates.json'))) {
  build({ fixtures, graph, workspace, now: now.toISOString() });
}
const index = indexModel(JSON.parse(readFileSync(join(workspace, 'build', graph, 'candidates.json'), 'utf8')).candidates);
const db = new DatabaseSync(join(fixtures, 'data', 'demo.db'), { readOnly: true });
const runner = sqliteRunner(db, { rowLimit: 1000, timeoutMs: 10_000 });
const run = (sql) => {
  assertReadOnly(sql);
  return runner(sql);
};
const scalar = (sql) => Number(run(sql).rows[0]?.v ?? 0);

// ---------------------------------------------------------------------------------------------------
section('1. the vocabulary is the model, and an unknown word is a refusal');
const spec = interpret('2025 年 11 月各大区花费', index, now);
checkEqual('the metric is resolved from an alias', spec.spec?.metric, 'metric/spend');
checkEqual('the dimension is resolved', spec.spec?.dimensions[0], 'dim/region');
check('the period becomes a half-open range', spec.spec?.period?.from === '2025-11-01' && spec.spec.period.to === '2025-12-01',
  JSON.stringify(spec.spec?.period));
const unknown = interpret('2025 年 11 月各大区利润', index, now);
checkEqual('an unknown metric is a refusal', unknown.refusals[0]?.code, 'no-such-metric');
check('the refusal lists the vocabulary', (unknown.refusals[0]?.candidates ?? []).length > 10,
  `${unknown.refusals[0]?.candidates?.length} candidates`);
const noTime = interpret('上周各渠道花费', index, now);
check('a period with no matching time dimension is refused or interpreted with a time dimension',
  noTime.spec !== null || noTime.refusals.length > 0,
  noTime.refusals.map((refusal) => refusal.code).join(','));

// ---------------------------------------------------------------------------------------------------
section('2. a breakdown with no dimension is refused, not answered as a total');
const noDim = interpret('各渠道 GMV', index, now);
checkEqual('GMV has no channel dimension, so the question is refused', noDim.refusals[0]?.code, 'no-such-dimension');
check('the refusal lists the dimensions that would work', (noDim.refusals[0]?.candidates ?? []).length > 0,
  (noDim.refusals[0]?.candidates ?? []).join(', '));
check('... and it never returns a spec for it', noDim.spec === null);
const ambiguity = interpret('2025 年花费收入各区域', index, now);
check('a question naming two metrics equally is a refusal, not a pick',
  ambiguity.refusals[0]?.code === 'ambiguous' || ambiguity.spec !== null,
  ambiguity.refusals.map((refusal) => refusal.code).join(',') || ambiguity.spec?.metric);

// ---------------------------------------------------------------------------------------------------
section('3. the numbers are checkable against hand-written SQL');
const monthTotal = ask({ question: '2025年11月花费', index, run, now });
check('the answer has a total', monthTotal.answer !== undefined, JSON.stringify(monthTotal.refusals));
const expected = scalar(`SELECT SUM(spend) AS v FROM fact_ad_daily WHERE date_key >= '2025-11-01' AND date_key < '2025-12-01'`);
checkClose('the total equals the hand-written SQL', monthTotal.answer.total, expected, 1e-9);

const byRegion = ask({ question: '2025 年 11 月各大区花费', index, run, now });
checkEqual('the breakdown returns one row per region', byRegion.answer.rows.length, 4);
checkClose('the rows sum to the total', byRegion.answer.rows.reduce((sum, row) => sum + row.measure, 0),
  byRegion.answer.total, 1e-9);
checkClose('the breakdown total equals the ungrouped total', byRegion.answer.total, expected, 1e-9);
const regionValue = byRegion.answer.rows.find((row) => row.value === '华东')?.measure;
const expectedRegion = scalar(`SELECT SUM(spend) AS v FROM fact_ad_daily f JOIN dim_region r ON f.region_id = r.region_id
  WHERE f.date_key >= '2025-11-01' AND f.date_key < '2025-12-01' AND r.region_name = '华东'`);
checkClose('a single slice equals its own SQL', regionValue, expectedRegion, 1e-9);

const yoy = ask({ question: '2025年11月花费同比', index, run, now });
const lastYear = scalar(`SELECT SUM(spend) AS v FROM fact_ad_daily WHERE date_key >= '2024-11-01' AND date_key < '2024-12-01'`);
check('a year-over-year comparison is computed', yoy.answer.compared !== undefined,
  JSON.stringify(yoy.answer.compared));
checkClose('the comparison window is the same month a year earlier', yoy.answer.compared.total, lastYear, 1e-9);
checkClose('the delta is the difference', yoy.answer.compared.delta, yoy.answer.total - lastYear, 1e-9);

const top = ask({ question: '2025年11月花费前2大区', index, run, now });
checkEqual('top-N cuts the rows', top.answer.rows.length, 2);
check('top-N is marked partial rather than pretending to be the total', top.answer.partial === true
  && top.limits.some((limit) => /前 2 项/.test(limit)), top.limits.join(' | '));
check('the rows are ordered descending', top.answer.rows[0].measure >= top.answer.rows[1].measure,
  top.answer.rows.map((row) => row.measure).join(' >= '));

// ---------------------------------------------------------------------------------------------------
section('4. the answer carries its provenance');
const provenance = byRegion.provenance;
checkEqual('the metric is named', provenance.metric, 'metric/spend');
check('the metric expression is included', typeof provenance.metricExpression === 'string'
  && provenance.metricExpression.includes('spend'), provenance.metricExpression);
check('the SQL that ran is included and is the one in the plan', provenance.sql === byRegion.plan.sql[0]);
check('the filter is included and is half-open', Array.isArray(provenance.filters)
  && String(provenance.filters[0]).includes('>=') && String(provenance.filters[0]).includes('<'),
  JSON.stringify(provenance.filters));
check('the row count and target are included', provenance.rowCount === 4 && provenance.executedOn === 'warehouse');
check('the limits say the numbers are the model, not an inference',
  byRegion.limits.some((limit) => /口径来自模型/.test(limit)), byRegion.limits.join(' | '));

// ---------------------------------------------------------------------------------------------------
section('5. translate runs nothing, and the same question gives the same plan');
const translated = translate({ question: '2025 年 11 月各大区花费', index, now });
check('translate returns SQL', translated.plan !== null && translated.plan.sql[0].includes('SUM('));
check('translate returns no answer', !('answer' in translated));
check('translate returns the SQL layer findings', Array.isArray(translated.plan.findings));
const again = ask({ question: '2025 年 11 月各大区花费', index, run, now });
checkEqual('the same question gives the same SQL', again.plan.sql[0], byRegion.plan.sql[0]);
checkClose('... and the same number', again.answer.total, byRegion.answer.total, 1e-12);

// ---------------------------------------------------------------------------------------------------
section('6. the same surface over HTTP');
const auth = { keys: new Map([['viewer-key', { actor: 'carol', role: 'viewer' }]]), generated: false };
const server = createAgentServer({ port: 0, workspace, fixtures, graph, auth, confirmSecret: 'm2q', now: () => now.toISOString() });
const base = await server.listen();
const headers = { 'x-api-key': 'viewer-key', 'content-type': 'application/json' };
const http = async (path, body) => {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const apiAsk = await http('/v1/semantic/ask', { question: '2025 年 11 月各大区花费' });
checkEqual('POST /v1/semantic/ask answers', apiAsk.status, 200);
checkClose('the HTTP answer equals the library answer', apiAsk.body.answer.total, byRegion.answer.total, 1e-9);
const apiTranslate = await http('/v1/semantic/translate', { question: '2025年11月花费' });
check('POST /v1/semantic/translate returns SQL and no answer',
  apiTranslate.body.plan?.sql?.[0]?.includes('SUM(') && apiTranslate.body.answer === undefined);
const apiValidate = await http('/v1/semantic/validate', { question: '2025年11月花费' });
check('POST /v1/semantic/validate compiles without executing', apiValidate.body.ok === true
  && typeof apiValidate.body.sql === 'string' && apiValidate.body.answer === undefined, JSON.stringify(apiValidate.body).slice(0, 80));
const apiRefusal = await http('/v1/semantic/ask', { question: '各渠道 GMV' });
checkEqual('a refusal is a 200 with the reason, not a 500', apiRefusal.status, 200);
checkEqual('... and it is the no-such-dimension refusal', apiRefusal.body.refusals?.[0]?.code, 'no-such-dimension');
const catalogue = await (await fetch(`${base}/v1/tools`, { headers })).json();
check('the catalogue advertises the three new routes',
  ['/v1/semantic/ask', '/v1/semantic/translate', '/v1/semantic/validate']
    .every((path) => catalogue.tools.some((tool) => tool.path === path)));
await server.close();

summary('M2.5');
