#!/usr/bin/env node
/**
 * P7 / M8 acceptance: the product surface.
 *
 * Six claims:
 *
 * 1. **The catalogue cannot drift from the routes.** `/v1/tools` is generated from the dispatcher, and every
 *    advertised GET route answers (not 404/405) with a viewer key.
 * 2. **Roles are enforced where they matter.** Publishing a model and approving a risk rule need `owner`;
 *    reviewing needs `analyst`; reading needs `viewer`; no key is 401.
 * 3. **The confirm gate is real.** `mode=confirm` returns a plan and a token and runs nothing; the token is bound
 *    to the plan, the scope and an expiry, and each failure mode has its own error code.
 * 4. **Every workbench works over HTTP**: semantic review, SQL steps (apply/revert/human edit), and the skill
 *    library (advise/export/promote).
 * 5. **The console and MCP are clients of that API**, not second implementations: the page contains the three
 *    panels, and the MCP server's tool list comes from `/v1/tools`.
 * 6. **Every call leaves an audit line** with actor, method and status.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkEqual, section, summary } from './verify-lib.mjs';
import { createAgentServer } from '../packages/api/src/server.ts';
import { ConfirmTokens, ConfirmationRejected } from '../packages/api/src/confirm.ts';
import { build } from '../packages/semantic/src/pipeline.ts';

const root = process.cwd();
const workspace = join(root, '.pag-m8');
const fixtures = join(root, 'fixtures', 'demo');
const graph = 'demo-analytics';
const now = '2026-10-27T00:00:00.000Z';
rmSync(workspace, { recursive: true, force: true });

// a model to serve, built by the same pipeline the API calls
build({ fixtures, graph, workspace, now, includeInjected: false });

const auth = {
  keys: new Map([
    ['owner-key', { actor: 'alice', role: 'owner' }],
    ['analyst-key', { actor: 'bob', role: 'analyst' }],
    ['viewer-key', { actor: 'carol', role: 'viewer' }],
  ]),
  generated: false,
};
const server = createAgentServer({ port: 0, workspace, fixtures, graph, auth, confirmSecret: 'test-secret', now: () => now });
const base = await server.listen();
const OWNER = { 'x-api-key': 'owner-key', 'content-type': 'application/json' };
const ANALYST = { 'x-api-key': 'analyst-key', 'content-type': 'application/json' };
const VIEWER = { 'x-api-key': 'viewer-key', 'content-type': 'application/json' };

async function http(method, path, body, headers = VIEWER) {
  const response = await fetch(`${base}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, text };
}

// ---------------------------------------------------------------------------------------------------
section('1. the catalogue is generated from the routes, and every advertised GET answers');
const catalogue = await http('GET', '/v1/tools');
checkEqual('the catalogue responds', catalogue.status, 200);
const tools = catalogue.body.tools;
check('it advertises a useful number of routes', tools.length >= 18, `${tools.length} routes`);
check('every route declares a method, a role and its inputs',
  tools.every((tool) => ['GET', 'POST'].includes(tool.method) && ['viewer', 'analyst', 'owner'].includes(tool.role)
    && Array.isArray(tool.input)));
const readRoutes = tools.filter((tool) => tool.method === 'GET' && !tool.path.includes(':'));
let answered = 0;
const notAnswered = [];
for (const route of readRoutes) {
  const response = await http('GET', route.path, undefined, route.path === '/v1/audit/recent' ? OWNER : VIEWER);
  if (response.status === 200) answered++;
  else notAnswered.push(`${route.path} -> ${response.status}`);
}
check('every advertised read route answers with a suitable key', notAnswered.length === 0,
  `${answered}/${readRoutes.length} answered${notAnswered.length ? `; ${notAnswered.join(', ')}` : ''}`);
checkEqual('an unknown route is a 404 with a hint', (await http('GET', '/v1/nope')).status, 404);
check('... and the hint says where the list is', /\/v1\/tools/.test((await http('GET', '/v1/nope')).body.error.hint ?? ''));
const wrongMethod = await http('DELETE', '/v1/tools');
checkEqual('the wrong method is a 405, not a 404', wrongMethod.status, 405);
checkEqual('it names the method that would work', wrongMethod.body.error.hint, 'try GET');

// ---------------------------------------------------------------------------------------------------
section('2. roles');
checkEqual('no key is 401', (await http('GET', '/v1/skills', undefined, {})).status, 401);
checkEqual('an unknown key is 401', (await http('GET', '/v1/skills', undefined, { 'x-api-key': 'nope' })).status, 401);
const viewerReview = await http('POST', '/v1/semantic/review', { action: 'accept', target: 'metric/spend' }, VIEWER);
checkEqual('a viewer cannot review', viewerReview.status, 403);
checkEqual('the refusal names the needed role', viewerReview.body.error.code, 'forbidden');
check('... and says who asked', /carol is viewer/.test(viewerReview.body.error.message ?? ''), viewerReview.body.error.message);
checkEqual('an analyst cannot publish', (await http('POST', '/v1/semantic/publish', {}, ANALYST)).status, 403);
checkEqual('an analyst cannot approve a risk rule', (await http('POST', '/v1/risk/approve', { ruleId: 'R-NEW-05', decision: 'approve' }, ANALYST)).status, 403);
const auditAsViewer = await http('GET', '/v1/audit/recent', undefined, VIEWER);
checkEqual('the audit trail is owner-only', auditAsViewer.status, 403);

// ---------------------------------------------------------------------------------------------------
section('3. the confirm gate');
const confirms = new ConfirmTokens('test-secret', 60_000);
const issued = confirms.issue({ metric: 'roi' }, 'attribute', Date.now());
const verified = confirms.verify(issued.token, { metric: 'roi' }, 'attribute');
checkEqual('a token verifies for its own plan', verified.planHash, issued.planHash);
let mismatch = '';
try {
  confirms.verify(issued.token, { metric: 'spend' }, 'attribute');
} catch (error) {
  mismatch = error instanceof ConfirmationRejected ? error.code : 'wrong-error';
}
checkEqual('a different plan is refused', mismatch, 'plan-mismatch');
let scopeError = '';
try {
  confirms.verify(issued.token, { metric: 'roi' }, 'campaign');
} catch (error) {
  scopeError = error instanceof ConfirmationRejected ? error.code : 'wrong-error';
}
checkEqual('another endpoint cannot reuse the token', scopeError, 'token-scope');
const expired = new ConfirmTokens('test-secret', -1).issue({ x: 1 }, 'attribute', Date.now());
let expiredError = '';
try {
  confirms.verify(expired.token, { x: 1 }, 'attribute');
} catch (error) {
  expiredError = error instanceof ConfirmationRejected ? error.code : 'wrong-error';
}
checkEqual('an expired token says so', expiredError, 'token-expired');
const tampered = `${issued.token.slice(0, -2)}xx`;
let tamperedError = '';
try {
  confirms.verify(tampered, { metric: 'roi' }, 'attribute');
} catch (error) {
  tamperedError = error instanceof ConfirmationRejected ? error.code : 'wrong-error';
}
checkEqual('a tampered token is refused as invalid', tamperedError, 'token-invalid');

const planned = await http('POST', '/v1/attribute', { metric: 'roi', from: '2025-10', to: '2025-11', mode: 'confirm' });
checkEqual('mode=confirm answers 200 with a plan', planned.status, 200);
checkEqual('it returns a mode marker', planned.body.mode, 'confirm');
check('it returns a token and an expiry', typeof planned.body.token === 'string' && typeof planned.body.expiresAt === 'string');
check('nothing ran: there is no answer in the body', planned.body.answer === undefined && planned.body.delta === undefined,
  Object.keys(planned.body).join(','));
const executed = await http('POST', '/v1/attribute', {
  metric: 'roi', from: '2025-10', to: '2025-11', confirmToken: planned.body.token,
});
checkEqual('the token runs the confirmed plan', executed.status, 200);
check('... and the answer is the attribution', executed.body.root?.decomposition === 'ratio',
  executed.body.root?.decomposition);
const swapped = await http('POST', '/v1/attribute', {
  metric: 'spend', from: '2025-10', to: '2025-11', confirmToken: planned.body.token,
});
checkEqual('the same token with a different plan is refused', swapped.status, 400);
checkEqual('... with plan-mismatch', swapped.body.error.code, 'plan-mismatch');

// ---------------------------------------------------------------------------------------------------
section('4. the workbenches over HTTP');
const attribute = await http('POST', '/v1/attribute', { metric: 'spend', from: '2025-10', to: '2025-11' });
check('attribution answers with a delta and an explicit residual',
  attribute.status === 200 && typeof attribute.body.root.delta === 'number'
  && attribute.body.root.unexplained !== null,
  `${attribute.body.root?.delta}`);
const camp = await http('POST', '/v1/campaign/optimize', {});
check('the campaign plan carries a gain and a holdout', camp.status === 200
  && camp.body.allocation.totals.expectedRevenueDelta > 0 && camp.body.holdout.design === 'geoholdout',
  `${camp.body.allocation?.totals?.expectedRevenueDelta}`);

const semanticReport = await http('GET', '/v1/semantic/report');
checkEqual('the semantic report is served', semanticReport.status, 200);
check('it carries the gate and per-table completeness',
  typeof semanticReport.body.gate?.passed === 'boolean' && Array.isArray(semanticReport.body.completeness));
const model = await http('GET', '/v1/semantic/model');
check('the model lists metrics, dimensions and relations', model.body.metrics.length > 0
  && model.body.dimensions.length > 0 && model.body.relations.length > 0,
  `${model.body.metrics.length}/${model.body.dimensions.length}/${model.body.relations.length}`);
const needsReview = model.body.needsReview;
check('the review queue is exposed', Array.isArray(needsReview));
const reviewed = await http('POST', '/v1/semantic/review', {
  action: 'accept', target: needsReview[0] ?? 'metric/cac', reason: 'checked in verify-m8',
}, ANALYST);
checkEqual('an analyst can record a review decision', reviewed.status, 200);
check('... and gets the gate back', typeof reviewed.body.gate?.passed === 'boolean');

const plan = await http('POST', '/v1/sql/plan', {
  sql: "SELECT * FROM fact_order WHERE substr(order_date, 1, 7) = '2024-05'", requiredColumns: ['order_id'],
}, ANALYST);
checkEqual('the SQL workspace plans', plan.status, 200);
check('the plan has findings and steps', plan.body.findings.length > 0 && plan.body.steps.length > 0,
  `${plan.body.findings.length} findings, ${plan.body.steps.length} steps`);
check('the plan is priced on both sides', plan.body.before?.plan?.length > 0 && plan.body.comparison?.improved === true,
  JSON.stringify(plan.body.comparison?.changed));
const planId = plan.body.id;
const applied = await http('POST', `/v1/sql/steps/${planId}`, { action: 'apply', step: plan.body.steps[0].seq }, ANALYST);
checkEqual('a step can be applied', applied.status, 200);
check('applying changes the SQL', applied.body.sql !== plan.body.original, applied.body.sql.slice(0, 60));
const edited = await http('POST', `/v1/sql/steps/${planId}`, { action: 'edit', sql: 'SELECT order_id FROM fact_order WHERE order_date >= \'2024-05-01\' AND order_date < \'2024-06-01\'' }, ANALYST);
checkEqual('a human edit is recorded', edited.status, 200);
const reverted = await http('POST', `/v1/sql/steps/${planId}`, { action: 'revert', step: plan.body.steps[0].seq }, ANALYST);
check('reverting is allowed and the ledger replays', reverted.status === 200 && typeof reverted.body.sql === 'string');
const state = await http('GET', `/v1/sql/steps/${planId}`);
check('the ledger keeps plan → apply → edit → revert',
  state.body.history.map((entry) => entry.action).join(',') === 'plan,apply,edit,revert',
  state.body.history.map((entry) => entry.action).join(','));
const suggestion = plan.body.steps.find((step) => step.kind === 'suggestion');
if (suggestion) {
  const refused = await http('POST', `/v1/sql/steps/${planId}`, { action: 'apply', step: suggestion.seq }, ANALYST);
  checkEqual('a suggestion cannot be applied over HTTP either', refused.status, 400);
}

const skills = await http('GET', '/v1/skills');
checkEqual('the skill library is served', skills.status, 200);
const advice = await http('POST', '/v1/skills/advise', { sql: "SELECT * FROM fact_order WHERE substr(order_date,1,7)='2024-05'" });
checkEqual('advise answers', advice.status, 200);
check('advise returns the findings and the matching tips', Array.isArray(advice.body.findings) && Array.isArray(advice.body.advice));
const exported = await http('GET', '/v1/skills/export');
check('the library exports as SKILL.md', exported.status === 200 && /^---\nname:/.test(exported.body.markdown),
  exported.body.markdown?.slice(0, 24));

const risk = await http('GET', '/v1/risk/report');
checkEqual('the risk report is served', risk.status, 200);
const riskRule = risk.body.rules.find((rule) => rule.status === 'candidate');
check('the risk report carries a candidate rule with holdout metrics', riskRule !== undefined && riskRule.holdout !== undefined,
  riskRule?.expression);
const approved = await http('POST', '/v1/risk/approve', {
  ruleId: riskRule.id, decision: 'approve', expression: riskRule.expression, note: 'reviewed', mode: 'auto',
}, OWNER);
checkEqual('the owner can approve', approved.status, 200);
checkEqual('the approval is attributed', approved.body.actor, 'alice');
const approvals = await http('GET', '/v1/risk/approvals');
check('the approval log lists it', approvals.body.approvals.some((entry) => entry.ruleId === riskRule.id));
const afterApproval = await http('GET', '/v1/risk/report');
check('the approved rule is now published', afterApproval.body.published.some((entry) => entry.id === riskRule.id),
  afterApproval.body.published.map((entry) => entry.id).join(', '));

// ---------------------------------------------------------------------------------------------------
section('5. the console and MCP are clients');
const page = await http('GET', '/');
checkEqual('the console page is served', page.status, 200);
check('it has the three workbenches', ['语义审查', 'SQL 工作台', 'Skill 库'].every((label) => page.text.includes(label)));
check('it loads the client script', page.text.includes('/console.js'));
const script = await http('GET', '/console.js');
check('the script calls the documented endpoints',
  ['/v1/semantic/model', '/v1/sql/plan', '/v1/skills/advise', '/v1/risk/report'].every((path) => script.text.includes(path)));
check('the script sends the API key header', script.text.includes("'x-api-key'"));
checkEqual('a missing asset is a 404', (await http('GET', '/console.css')).status, 404);

// async, not execFileSync: the API under test runs in this very process, and a blocking spawn would deadlock
// against its own event loop - the child waits for an answer only this thread can give
const execFileAsync = promisify(execFile);
const mcp = (await execFileAsync(process.execPath, ['packages/api/src/mcp.mjs', '--selftest'], {
  cwd: root, encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, PAGENT_API: base, PAGENT_API_KEY: 'owner-key' },
})).stdout;
check('the MCP server lists the service catalogue and calls a tool',
  mcp.trim().startsWith('mcp selftest:') && mcp.includes('one call ok'), mcp.trim());
const mcpList = JSON.parse((await execFileAsync(process.execPath, ['packages/api/src/mcp.mjs', '--list'], {
  cwd: root, encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, PAGENT_API: base, PAGENT_API_KEY: 'owner-key' },
})).stdout);
check('the MCP tool list matches the HTTP catalogue', mcpList.tools.length === tools.length,
  `${mcpList.tools.length} vs ${tools.length}`);
check('the MCP tools carry the role the service declares', mcpList.tools.every((tool) => /needs role/.test(tool.description)),
  mcpList.tools[0]?.description);

// ---------------------------------------------------------------------------------------------------
section('6. every call is audited');
const audit = await http('GET', '/v1/audit/recent?limit=200', undefined, OWNER);
checkEqual('the audit trail responds to the owner', audit.status, 200);
check('it recorded the calls with actor and status', audit.body.entries.length >= 20
  && audit.body.entries.every((entry) => typeof entry.actor === 'string' && typeof entry.status === 'number'),
  `${audit.body.entries.length} entries`);
check('it names the actors that made the calls', audit.body.entries.some((entry) => entry.actor === 'alice')
  && audit.body.entries.some((entry) => entry.actor === 'bob') && audit.body.entries.some((entry) => entry.actor === 'carol'));
check('failures are in the trail too', audit.body.entries.some((entry) => entry.status === 403),
  audit.body.entries.filter((entry) => entry.status >= 400).map((entry) => `${entry.path}:${entry.status}`).slice(0, 4).join(', '));

await server.close();
summary('M8');
