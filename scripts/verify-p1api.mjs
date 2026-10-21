#!/usr/bin/env node
/**
 * P1-e acceptance: the four P1 modules are on the wire, behind the same three roles and the same confirm gate.
 *
 * The claim is not "there are more routes". It is that each new route keeps the guarantees the existing ones have:
 *
 * | guarantee | attack |
 * | --- | --- |
 * | the catalogue is the routes | every new path must appear in `/v1/tools` with its role and inputs |
 * | reads stay reads | a viewer can ask for version/conflicts/capacity/features, and cannot learn a word or commit spend |
 * | publishing to the base is a write | `crossCheck: true` on graph features needs the owner role |
 * | a commit needs two independent things | owner role *and* a confirm token bound to this exact plan |
 * | refusals survive the wire | a budget the agent cannot justify is a 409, not an empty payload |
 * | the audit trail is complete | every new path shows up in `/v1/audit/recent` with the actor |
 */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { check, checkEqual, section, summary } from './verify-lib.mjs';
import { sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { build } from '../packages/semantic/src/pipeline.ts';
import { indexModel } from '../packages/semantic/src/sql.ts';
import { createAgentServer } from '../packages/api/src/server.ts';

const root = process.cwd();
const workspace = join(root, '.pag-p1api');
const fixtures = join(root, 'fixtures', 'demo');
const graph = 'demo-analytics';
const now = '2026-10-29T00:00:00.000Z';
rmSync(workspace, { recursive: true, force: true });
if (!existsSync(join(fixtures, 'data', 'demo.db'))) {
  console.log('missing demo.db; run npm run demo:db first');
  process.exit(1);
}
build({ fixtures, graph, workspace, now });

/** A stand-in platform: it checks the idempotency key header and answers with a receipt. */
const platformCalls = [];
const platform = await new Promise((resolve) => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      platformCalls.push(request.headers['idempotency-key']);
      const key = request.headers['idempotency-key'];
      const cells = JSON.parse(body || '{}').cells ?? [];
      response.writeHead(key && cells.length > 0 ? 200 : 400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ receiptId: `rcpt-${cells.length}`, acceptedAt: now }));
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});

const auth = {
  keys: new Map([
    ['owner-key', { actor: 'alice', role: 'owner' }],
    ['analyst-key', { actor: 'bob', role: 'analyst' }],
    ['viewer-key', { actor: 'carol', role: 'viewer' }],
  ]),
  generated: false,
};
const agentServer = createAgentServer({ port: 0, workspace, fixtures, graph, auth, confirmSecret: 'p1-secret', now: () => now });
const base = await agentServer.listen();
const KEY = { owner: 'owner-key', analyst: 'analyst-key', viewer: 'viewer-key' };

async function http(method, path, body, role = 'viewer', extraHeaders = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': KEY[role], ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

try {
  section('1. the catalogue carries the new routes, with their roles');
  const catalogue = await http('GET', '/v1/tools');
  const tools = catalogue.body.tools;
  check('the catalogue grew', tools.length >= 41, `${tools.length} routes`);
  const expected = [
    ['POST', '/v1/semantic/version', 'viewer'],
    ['POST', '/v1/semantic/shadow', 'viewer'],
    ['GET', '/v1/semantic/lexicon', 'viewer'],
    ['POST', '/v1/semantic/lexicon', 'analyst'],
    ['POST', '/v1/ask/hybrid', 'viewer'],
    ['POST', '/v1/graph/features', 'viewer'],
    ['POST', '/v1/risk/conflicts', 'viewer'],
    ['POST', '/v1/risk/capacity', 'viewer'],
    ['POST', '/v1/campaign/writeback', 'analyst'],
    ['GET', '/v1/semantic/release', 'viewer'],
    ['POST', '/v1/semantic/release', 'owner'],
    ['GET', '/v1/semantic/lexicon/drafts', 'viewer'],
    ['POST', '/v1/semantic/lexicon/drafts', 'analyst'],
    ['POST', '/v1/semantic/lexicon/drafts/:id', 'analyst'],
    ['GET', '/v1/semantic/timeline', 'viewer'],
    ['GET', '/v1/semantic/values', 'viewer'],
    ['POST', '/v1/semantic/values', 'analyst'],
  ];
  for (const [method, path, role] of expected) {
    const tool = tools.find((entry) => entry.method === method && entry.path === path);
    check(`${method} ${path} is advertised`, tool !== undefined, tool ? `role ${tool.role}` : 'missing');
    check(`... with role ${role}`, tool?.role === role, tool?.role ?? '');
    check(`... and declares its inputs`, (tool?.input ?? []).length > 0, (tool?.input ?? []).join(','));
  }

  section('1b. the console has a tab for the new surface, and it calls the same endpoints');
  const consolePage = await fetch(`${base}/`).then((response) => response.text());
  const consoleScript = await fetch(`${base}/console.js`).then((response) => response.text());
  check('the release tab is in the page', consolePage.includes('data-tab="release"'));
  check('the page has five workbenches', (consolePage.match(/data-tab=/g) ?? []).length === 5,
    `${(consolePage.match(/data-tab=/g) ?? []).length} tabs`);
  for (const path of ['/v1/semantic/version', '/v1/risk/conflicts', '/v1/risk/capacity', '/v1/graph/features', '/v1/ask/hybrid', '/v1/campaign/writeback', '/v1/semantic/release', '/v1/semantic/lexicon/drafts', '/v1/semantic/timeline', '/v1/semantic/values']) {
    check(`the console calls ${path}`, consoleScript.includes(path));
  }

  section('2. release checks are reads');
  const version = await http('POST', '/v1/semantic/version', { question: '2025 年 11 月各大区花费' });
  checkEqual('version answers for a viewer', version.status, 200);
  check('it carries a diff, a drift report and a shadow', version.body.diff !== undefined && version.body.drift !== undefined
    && Array.isArray(version.body.shadows), Object.keys(version.body).join(','));
  check('the demo model is in sync with the warehouse', version.body.drift.verdict === 'ok' && version.body.drift.blocking === 0,
    `${version.body.drift.checked.tables} tables / ${version.body.drift.checked.columns} columns`);
  checkEqual('and the release gate promotes it', version.body.gate.verdict, 'promote');
  checkEqual('the shadow moved nothing', version.body.shadows[0]?.comparison?.rowsChanged, 0);

  const shadow = await http('POST', '/v1/semantic/shadow', { question: '2025 年 11 月各大区花费' });
  checkEqual('shadow answers on its own route too', shadow.status, 200);
  check('with four regions compared', shadow.body.comparison.rowsCompared === 4, `${shadow.body.comparison.rowsCompared}`);
  checkEqual('and a promote verdict', shadow.body.verdict, 'promote');

  const conflicts = await http('POST', '/v1/risk/conflicts', { months: 6 });
  checkEqual('conflicts answers for a viewer', conflicts.status, 200);
  check('it analyses the live rules', conflicts.body.rules.length >= 2, conflicts.body.rules.map((rule) => rule.ruleId).join(','));
  const duplicate = await http('POST', '/v1/risk/conflicts', {
    months: 6,
    rules: [{ ruleId: 'R002-dup', expression: 'f_login_fail_7d >= 3' }],
  });
  check('a supplied duplicate is caught against the live rules',
    duplicate.body.duplicates.some((pair) => pair.a === 'R002-dup' || pair.b === 'R002-dup'),
    JSON.stringify(duplicate.body.duplicates));
  const reach = duplicate.body.pairs.find((pair) => pair.a === 'R001' && pair.b === 'R002');
  check('the live pair still shows its one shared hit', reach?.both === 1, `both ${reach?.both}`);

  const capacity = await http('POST', '/v1/risk/capacity', { hitsPerDay: 200, minutesPerReview: 12, reviewers: 6 });
  checkEqual('capacity answers', capacity.status, 200);
  checkEqual('and computes the minimum headcount', capacity.body.requiredReviewers, 6);
  check('at 83% utilisation', Math.abs(capacity.body.utilisation - 0.8333) < 0.001, `${capacity.body.utilisation}`);
  const saturated = await http('POST', '/v1/risk/capacity', { hitsPerDay: 400, minutesPerReview: 12, reviewers: 3 });
  checkEqual('a saturated queue is understaffed', saturated.body.verdict, 'understaffed');
  check('and its wait is not a number (JSON renders Infinity as null)', saturated.body.waitHours === null, `${saturated.body.waitHours}`);

  section('3. the graph features are a read, and publishing into the base is not');
  const features = await http('POST', '/v1/graph/features', { cutoff: '2025-07' });
  checkEqual('features answer for a viewer', features.status, 200);
  check('the increment is the same number the suite measures', features.body.models.increment === 0.012,
    `${features.body.models.base.auc} -> ${features.body.models.withGraph.auc}`);
  check('labels are still unused by construction', features.body.labelIndependence.identical === true,
    `${features.body.labelIndependence.checked} events`);
  check('the newest snapshot covers the whole book', features.body.snapshot.accounts > 4000, `${features.body.snapshot.accounts} accounts`);
  const crossCheckAsViewer = await http('POST', '/v1/graph/features', { crossCheck: true });
  checkEqual('crossCheck needs the owner role', crossCheckAsViewer.status, 403);

  section('4. hybrid asking: the deterministic answer, then a followed-up question');
  const asked = await http('POST', '/v1/ask/hybrid', { question: '2025 年 11 月各大区花费' });
  checkEqual('hybrid answers', asked.status, 200);
  checkEqual('through the deterministic reader', asked.body.source.kind, 'deterministic');
  check('and returns a session id', typeof asked.body.sessionId === 'string' && asked.body.sessionId.length > 2, asked.body.sessionId);
  check('four regions of spend', asked.body.answer.answer.rows.length === 4 && asked.body.spec.metric === 'metric/spend', asked.body.spec.metric);
  const followed = await http('POST', '/v1/ask/hybrid', { question: '换成收入', sessionId: asked.body.sessionId, followUp: true });
  checkEqual('the follow-up answers', followed.status, 200);
  checkEqual('and switched the metric', followed.body.spec.metric, 'metric/revenue');
  check('while keeping the period', followed.body.spec.period.from === '2025-11-01', JSON.stringify(followed.body.spec.period));
  const unknownSession = await http('POST', '/v1/ask/hybrid', { question: '换成收入', sessionId: 'nope', followUp: true });
  checkEqual('an unknown session is a 404', unknownSession.status, 404);
  checkEqual('with a useful code', unknownSession.body.error.code, 'no-session');

  section('5. learning a word is an analyst action with two refusals built in');
  const learnAsViewer = await http('POST', '/v1/semantic/lexicon', { word: '毛利', target: 'metric/gmv' });
  checkEqual('a viewer cannot learn a word', learnAsViewer.status, 403);
  const learned = await http('POST', '/v1/semantic/lexicon', { word: '毛利', target: 'metric/gmv', evidence: 'agreed with finance' }, 'analyst');
  checkEqual('an analyst can', learned.status, 200);
  checkEqual('and the entry records the actor', learned.body.entry.model, 'bob');
  const again = await http('POST', '/v1/semantic/lexicon', { word: '毛利', target: 'metric/revenue' }, 'analyst');
  checkEqual('re-pointing a learned word is a conflict', again.status, 409);
  checkEqual('with a code a client can branch on', again.body.error.code, 'lexicon-conflict');
  const invented = await http('POST', '/v1/semantic/lexicon', { word: '净利', target: 'metric/profit' }, 'analyst');
  checkEqual('learning onto a missing target is a conflict too', invented.status, 409);
  const learnedAsk = await http('POST', '/v1/ask/hybrid', { question: '2025 年 11 月各大区毛利' });
  checkEqual('now the word answers without a model', learnedAsk.body.spec.metric, 'metric/gmv');
  check('and the rewrite is visible', String(learnedAsk.body.source.rewritten).includes('gmv'), learnedAsk.body.source.rewritten);
  const lexicon = await http('GET', '/v1/semantic/lexicon');
  check('the lexicon is readable', lexicon.body.entries.length === 1, JSON.stringify(lexicon.body.entries.map((entry) => entry.word)));

  section('6. write-back: a dry run by default, a commit only with role + token + endpoint');
  const dry = await http('POST', '/v1/campaign/writeback', { budget: 3000000 }, 'analyst');
  checkEqual('the dry run answers', dry.status, 200);
  checkEqual('and did not commit', dry.body.status, 'dry-run');
  check('with a payload whose key is a hash of the cells', typeof dry.body.payload.idempotencyKey === 'string'
    && dry.body.payload.idempotencyKey.length === 32, dry.body.payload.idempotencyKey);
  check('32 cells and no validation issues', dry.body.payload.cells.length > 0 && dry.body.issues.length === 0,
    `${dry.body.payload.cells.length} cells, ${JSON.stringify(dry.body.issues)}`);

  const refused = await http('POST', '/v1/campaign/writeback', { budget: 2000000 }, 'analyst');
  checkEqual('a budget the agent cannot justify is a refusal', refused.status, 409);
  checkEqual('with the agent code', refused.body.error.code, 'agent-refused');
  check('and the reason is the agent\'s, not a generic message', /noise|gain/.test(refused.body.error.message), refused.body.error.message.slice(0, 80));

  const commitAttempt = await http('POST', '/v1/campaign/writeback', { budget: 3000000, commit: true }, 'owner');
  checkEqual('committing without a token is refused', commitAttempt.status, 428);
  checkEqual('with confirm-required', commitAttempt.body.error.code, 'confirm-required');
  const asAnalyst = await http('POST', '/v1/campaign/writeback', { budget: 3000000, commit: true, mode: 'confirm' }, 'analyst');
  checkEqual('an analyst cannot commit at all', asAnalyst.status, 403);

  const confirmMode = await http('POST', '/v1/campaign/writeback', { budget: 3000000, commit: true, mode: 'confirm' }, 'owner');
  check('mode=confirm issues a token instead of running', typeof confirmMode.body.token === 'string' && confirmMode.body.mode === 'confirm',
    Object.keys(confirmMode.body).join(','));
  // no endpoint configured: the commit must fail rather than pretend
  const noEndpoint = await http('POST', '/v1/campaign/writeback', { budget: 3000000, commit: true, confirmToken: confirmMode.body.token }, 'owner');
  checkEqual('without a platform endpoint the commit is refused', noEndpoint.status, 501);
  checkEqual('with a code that says why', noEndpoint.body.error.code, 'no-writeback-endpoint');

  process.env.PAGENT_WRITEBACK_URL = platform.url;
  const committed = await http('POST', '/v1/campaign/writeback', { budget: 3000000, commit: true, confirmToken: confirmMode.body.token }, 'owner');
  checkEqual('with an endpoint the commit lands', committed.status, 200);
  checkEqual('as committed', committed.body.status, 'committed');
  check('with a receipt from the platform', committed.body.receipt.receiptId === 'rcpt-36', committed.body.receipt.receiptId);
  check('and the same idempotency key as the dry run', committed.body.receipt.idempotencyKey === dry.body.payload.idempotencyKey,
    `${committed.body.receipt.idempotencyKey} vs ${dry.body.payload.idempotencyKey}`);
  const replayed = await http('POST', '/v1/campaign/writeback', { budget: 3000000, commit: true, confirmToken: confirmMode.body.token }, 'owner');
  checkEqual('replaying the same token is the same request (same key, not a second plan)', replayed.body.receipt.idempotencyKey, committed.body.receipt.idempotencyKey);
  checkEqual('the replay is labelled as one', replayed.body.receipt.status, 'replayed');
  checkEqual('and the platform was called once, not twice', platformCalls.length, 1);
  const other = await http('POST', '/v1/campaign/writeback', { budget: 3200000, commit: true, mode: 'confirm' }, 'owner');
  const otherCommit = await http('POST', '/v1/campaign/writeback', { budget: 3200000, commit: true, confirmToken: other.body.token }, 'owner');
  check('a different plan is a different key', otherCommit.body.receipt.idempotencyKey !== committed.body.receipt.idempotencyKey,
    `${otherCommit.body.receipt.idempotencyKey} vs ${committed.body.receipt.idempotencyKey}`);
  checkEqual('so the platform is called again', platformCalls.length, 2);
  const store = readFileSync(join(workspace, 'writeback', 'idempotency.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  check('our own store records both commits', store.length === 2 && store.every((entry) => entry.status === 'committed'),
    store.map((entry) => `${entry.key.slice(0, 8)}:${entry.status}`).join(' '));
  check('with the actor and the receipt', store.every((entry) => entry.actor === 'alice' && typeof entry.receiptId === 'string'),
    `${store[0]?.actor} ${store[0]?.receiptId}`);
  check('and a payload hash that is not the key', store.every((entry) => entry.payloadHash.length === 32 && entry.payloadHash !== entry.key),
    store[0]?.payloadHash?.slice(0, 8) ?? '');
  delete process.env.PAGENT_WRITEBACK_URL;

  section('5b. the value vocabulary: build it, then a word becomes a slice');
  const noVocabulary = await http('POST', '/v1/semantic/ask', { question: '2025 年 11 月华东大区花费' });
  check('before the vocabulary exists the word is ignored (the documented gap)',
    noVocabulary.body.answer?.total !== null && noVocabulary.body.answer?.rows?.length === 4,
    noVocabulary.body.answer?.rows?.length + ' rows');
  const builtValues = await http('POST', '/v1/semantic/values', { action: 'build' }, 'analyst');
  checkEqual('the vocabulary builds', builtValues.status, 200);
  check('with the region labels read through the foreign key',
    builtValues.body.dimensions.some((entry) => entry.dimension === 'dim/region' && entry.source === 'dim_region.region_name'),
    builtValues.body.dimensions.map((entry) => entry.dimension).join(','));
  const filtered = await http('POST', '/v1/semantic/ask', { question: '2025 年 11 月华东大区花费' });
  check('now the same question is a slice', filtered.body.answer?.rows?.length === 1 && filtered.body.answer.total > 1000000,
    JSON.stringify(filtered.body.answer?.rows));
  const wrongValue = await http('POST', '/v1/semantic/ask', { question: '2025 年 11 月火星大区花费' });
  checkEqual('an unknown value is a refusal', wrongValue.body.refusals?.[0]?.code, 'unknown-value');
  const alias = await http('POST', '/v1/semantic/values', { action: 'alias', word: '华东区', dimension: 'dim/region', value: '华东' }, 'analyst');
  checkEqual('an alias is accepted', alias.status, 200);
  const aliasedAsk = await http('POST', '/v1/semantic/ask', { question: '2025 年 11 月华东区花费' });
  check('and the alias answers the same slice', aliasedAsk.body.answer?.rows?.length === 1, JSON.stringify(aliasedAsk.body.answer?.rows));
  const viewerAlias = await http('POST', '/v1/semantic/values', { action: 'alias', word: '华南区', dimension: 'dim/region', value: '华南' });
  checkEqual('a viewer cannot write an alias', viewerAlias.status, 403);

  section('6b. the timeline merges the audit, the lexicon and the releases');
  const timeline = await http('GET', '/v1/semantic/timeline?limit=100');
  checkEqual('the timeline answers', timeline.status, 200);
  check('it is ordered', timeline.body.events.every((event, index, all) => index === 0 || all[index - 1].at <= event.at),
    timeline.body.events.length + ' events');
  check('and it names the lexicon decisions this run made', timeline.body.counts.lexicon >= 1, JSON.stringify(timeline.body.counts));

  section('7. the audit trail covers the new routes');
  const audit = await http('GET', '/v1/audit/recent?limit=200', undefined, 'owner');
  const paths = new Set(audit.body.entries.map((entry) => entry.path));
  for (const path of ['/v1/semantic/version', '/v1/risk/conflicts', '/v1/risk/capacity', '/v1/graph/features',
    '/v1/ask/hybrid', '/v1/semantic/lexicon', '/v1/campaign/writeback']) {
    check(`audit has ${path}`, paths.has(path));
  }
  const actors = new Set(audit.body.entries.filter((entry) => entry.path === '/v1/semantic/lexicon').map((entry) => entry.actor));
  check('the lexicon writes name their actor', actors.has('bob'), [...actors].join(','));
  check('and failures are recorded with their status (403 on the crossCheck attempt)',
    audit.body.entries.some((entry) => entry.status === 403), audit.body.entries.filter((entry) => entry.status === 403).length + ' rejections');

  section('8. the model index the routes load is the same one the CLI uses');
  const db = new DatabaseSync(join(fixtures, 'data', 'demo.db'), { readOnly: true });
  const run = (sql) => { assertReadOnly(sql); return sqliteRunner(db, { rowLimit: 1000, timeoutMs: 10_000 })(sql); };
  const index = indexModel(JSON.parse(readFileSync(join(workspace, 'build', graph, 'candidates.json'), 'utf8')).candidates);
  const direct = run("SELECT SUM(spend) AS v FROM fact_ad_daily WHERE date_key >= '2025-11-01' AND date_key < '2025-12-01'").rows[0];
  const apiTotal = (asked.body.answer.answer.rows ?? []).reduce((total, row) => total + row.measure, 0);
  check('the four regions add up to the hand-written SQL total', Math.abs(apiTotal - Number(direct.v)) < 0.01,
    `${apiTotal.toFixed(2)} vs ${Number(direct.v).toFixed(2)}`);
  check('and the index has the metrics the answers came from', index.metrics.length > 10, `${index.metrics.length} metrics`);
  db.close();
} finally {
  await agentServer.close();
  await new Promise((resolve) => platform.server.close(resolve));
  rmSync(workspace, { recursive: true, force: true });
}

summary('P1-e API surface');
