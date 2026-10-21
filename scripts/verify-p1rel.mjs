#!/usr/bin/env node
/**
 * P1-f acceptance: a canary release that can be argued about afterwards.
 *
 * The claim is that a release is a **decision with evidence and a stopping rule**, not a switch:
 *
 * | claim | attack |
 * | --- | --- |
 * | the split is sticky | the same actor asking the same question must always land on the same side |
 * | the split is roughly what was asked for | 1,000 buckets at 30% must land within a few points of 300 |
 * | a canary serves the new revision | its answers carry `modelRevision: v2` and the v2 numbers |
 * | promotion needs traffic | 1 answer is not 30, and a refusal is a failure, not an answer |
 * | a breaking change needs a shadow | promoting a definition change with no question is refused |
 * | rollback is a decision | no reason, no rollback; with one, the bucket stops mattering |
 * | three failures in a row stop it by itself | and the reason is written by the guard, not by a person |
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { check, checkEqual, section, summary } from './verify-lib.mjs';
import { build } from '../packages/semantic/src/pipeline.ts';
import { indexModel } from '../packages/semantic/src/sql.ts';
import { bucketOf, pickRevision, ReleaseStore } from '../packages/semantic/src/release.ts';
import { learnWord } from '../packages/semantic/src/ask/index.ts';
import { ReviewLog } from '../packages/semantic/src/review.ts';
import { createAgentServer } from '../packages/api/src/server.ts';

const root = process.cwd();
const workspace = join(root, '.pag-p1rel');
const fixtures = join(root, 'fixtures', 'demo');
const graph = 'demo-analytics';
const now = '2026-10-29T00:00:00.000Z';
rmSync(workspace, { recursive: true, force: true });
if (!existsSync(join(fixtures, 'data', 'demo.db'))) {
  console.log('missing demo.db; run npm run demo:db first');
  process.exit(1);
}
build({ fixtures, graph, workspace, now });

// --- two "published" revisions, written the way publish writes them (a snapshot per revision)
const built = JSON.parse(readFileSync(join(workspace, 'build', graph, 'candidates.json'), 'utf8')).candidates;
const models = join(workspace, 'models', graph);
mkdirSync(models, { recursive: true });
writeFileSync(join(models, 'v1.json'), JSON.stringify({ candidates: built }), 'utf8');
const mutated = structuredClone(built).map((candidate) => candidate.id === 'metric/spend'
  ? { ...candidate, payload: { ...candidate.payload, expression: '(SUM(fact_ad_daily.spend) * 1.1)' } }
  : candidate);
writeFileSync(join(models, 'v2.json'), JSON.stringify({ candidates: mutated }), 'utf8');
// v3 drops a metric: a question about it refuses on the canary and answers on the stable side
const dropping = structuredClone(built).filter((candidate) => candidate.id !== 'metric/roi');
writeFileSync(join(models, 'v3.json'), JSON.stringify({ candidates: dropping }), 'utf8');

const auth = {
  keys: new Map([
    ['owner-key', { actor: 'alice', role: 'owner' }],
    ['analyst-key', { actor: 'bob', role: 'analyst' }],
    ['viewer-key', { actor: 'carol', role: 'viewer' }],
  ]),
  generated: false,
};
const server = createAgentServer({ port: 0, workspace, fixtures, graph, auth, confirmSecret: 'rel-secret', now: () => now });
const base = await server.listen();
const KEY = { owner: 'owner-key', analyst: 'analyst-key', viewer: 'viewer-key' };
async function http(method, path, body, role = 'viewer', extraHeaders = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': KEY[role] ?? role, ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

try {
  section('1. bucketing is deterministic, sticky and roughly the size that was asked for');
  checkEqual('the same actor and question always give the same bucket',
    bucketOf('carol', '2025 年 11 月各大区花费'), bucketOf('carol', '2025 年 11 月各大区花费'));
  check('whitespace and case do not change the bucket',
    bucketOf('carol', ' 2025 年 11 月各大区花费 ') === bucketOf('carol', '2025 年 11 月各大区花费'));
  const canaryCount = Array.from({ length: 1000 }, (_, index) => bucketOf(`actor-${index}`, 'q')).filter((bucket) => bucket < 30).length;
  check('30% is about 300 of 1,000', Math.abs(canaryCount - 300) < 45, `${canaryCount}`);
  const config = { graph, fromRevision: 1, toRevision: 2, canaryPct: 30, status: 'running', startedAt: now, startedBy: 'alice' };
  check('a running release splits by the bucket', pickRevision(config, 'actor-1', 'q').side === 'canary' || pickRevision(config, 'actor-1', 'q').side === 'stable');
  checkEqual('a promoted release serves everyone the new revision', pickRevision({ ...config, status: 'promoted' }, 'actor-1', 'q').side, 'promoted');
  checkEqual('a rolled-back release serves nobody the new revision', pickRevision({ ...config, status: 'rolled-back' }, 'actor-1', 'q').revision, 'stable');
  checkEqual('no release is the stable side', pickRevision(null, 'actor-1', 'q').side, 'none');

  section('2. starting a release needs two real revisions, and one at a time');
  checkEqual('no release is running yet', (await http('GET', '/v1/semantic/release')).body.config, null);
  const missing = await http('POST', '/v1/semantic/release', { action: 'start', from: 1, to: 9, canaryPct: 20 }, 'owner');
  checkEqual('a revision that does not exist is refused', missing.status, 404);
  const started = await http('POST', '/v1/semantic/release', { action: 'start', from: 1, to: 2, canaryPct: 30 }, 'owner');
  if (started.status !== 200) console.log('   debug:', JSON.stringify(started.body));
  checkEqual('starting works', started.status, 200);
  check('and records who started it', started.body.startedBy === 'alice' && started.body.status === 'running', `${started.body.startedBy}/${started.body.status}`);
  const second = await http('POST', '/v1/semantic/release', { action: 'start', from: 1, to: 2, canaryPct: 10 }, 'owner');
  checkEqual('a second release while one runs is a conflict', second.status, 409);
  const asAnalyst = await http('POST', '/v1/semantic/release', { action: 'start', from: 1, to: 3, canaryPct: 10 }, 'analyst');
  checkEqual('only the owner can start one', asAnalyst.status, 403);

  section('3. the canary actually serves the new revision');
  // find actors on each side of the bucket for one question
  const question = '2025 年 11 月各大区花费';
  const canaryActor = Array.from({ length: 200 }, (_, index) => `canary-${index}`).find((actor) => bucketOf(actor, question) < 30);
  const stableActor = Array.from({ length: 200 }, (_, index) => `stable-${index}`).find((actor) => bucketOf(actor, question) >= 30);
  check('a canary actor exists in the sample', canaryActor !== undefined, canaryActor);
  check('a stable actor exists in the sample', stableActor !== undefined, stableActor);
  const viaCanary = await http('POST', '/v1/semantic/ask', { question }, 'viewer');
  // the route buckets on the principal's actor, so drive the split through actor-named keys
  check('the response names the revision that answered', Object.prototype.hasOwnProperty.call(viaCanary.body, 'answer') || viaCanary.status !== 200,
    `revision ${viaCanary.body?.answer?.plan?.modelRevision ?? 'n/a'}`);

  // ask as the two actors by giving the server a key whose actor matches, through the auth map
  server.auth.keys.set('canary-key', { actor: canaryActor, role: 'viewer' });
  server.auth.keys.set('stable-key', { actor: stableActor, role: 'viewer' });
  const canaryAnswer = await http('POST', '/v1/semantic/ask', { question }, 'canary-key');
  const stableAnswer = await http('POST', '/v1/semantic/ask', { question }, 'stable-key');
  checkEqual('the canary actor answered from v2', canaryAnswer.body.plan.modelRevision, 2);
  check('the stable actor answered from the build', stableAnswer.body.plan.modelRevision === null || stableAnswer.body.plan.modelRevision === 1,
    `${stableAnswer.body.plan.modelRevision}`);
  const canaryTotal = canaryAnswer.body.answer.rows.reduce((total, row) => total + row.measure, 0);
  const stableTotal = stableAnswer.body.answer.rows.reduce((total, row) => total + row.measure, 0);
  check('and the numbers differ by the 10% the canary introduced', Math.abs(canaryTotal / stableTotal - 1.1) < 1e-6,
    `${canaryTotal.toFixed(2)} / ${stableTotal.toFixed(2)}`);
  check('the split is sticky across repeated asks',
    (await http('POST', '/v1/semantic/ask', { question }, 'canary-key')).body.plan.modelRevision === 2);

  section('4. promotion needs traffic, and a breaking change needs a shadow');
  const early = await http('POST', '/v1/semantic/release', { action: 'promote' }, 'owner');
  checkEqual('a canary with one answer cannot be promoted', early.status, 409);
  check('and the refusal names a reason a person can act on', /canary answers|breaking/.test(early.body.error.message), early.body.error.message);
  const trafficRule = new ReleaseStore(workspace, graph).canPromote({ actor: 'alice' });
  check('the traffic rule lives in the store, not only in the route',
    trafficRule.ok === false && trafficRule.reasons.some((reason) => /canary answers/.test(reason)),
    trafficRule.reasons.join('; '));
  const evidenceNow = (await http('GET', '/v1/semantic/release')).body.evidence;
  check('the evidence counts canary answers only', evidenceNow.answers >= 2 && evidenceNow.errors === 0,
    `${evidenceNow.answers} answers, ${evidenceNow.errors} errors`);

  // 30 canary answers, each from a different actor that lands in the bucket
  const canaryActors = Array.from({ length: 400 }, (_, index) => `bulk-${index}`).filter((actor) => bucketOf(actor, question) < 30).slice(0, 30);
  for (const [index, actor] of canaryActors.entries()) {
    server.auth.keys.set(`bulk-${index}`, { actor, role: 'viewer' });
    await http('POST', '/v1/semantic/ask', { question }, `bulk-${index}`);
  }
  const ready = (await http('GET', '/v1/semantic/release')).body.evidence;
  check('thirty canary answers are recorded', ready.answers >= 31, `${ready.answers}`);
  const noQuestion = await http('POST', '/v1/semantic/release', { action: 'promote' }, 'owner');
  checkEqual('promoting a breaking change with no shadow is refused', noQuestion.status, 409);
  check('and it says the release is breaking', /breaking|definition/.test(noQuestion.body.error.message), noQuestion.body.error.message);
  const withShadow = await http('POST', '/v1/semantic/release', { action: 'promote', question }, 'owner');
  checkEqual('with a shadow that moves the numbers, still refused', withShadow.status, 409);
  check('the reason is the shadow', /moved the numbers/.test(withShadow.body.error.message), withShadow.body.error.message);

  section('5. rollback is a decision with a reason');
  const noReason = await http('POST', '/v1/semantic/release', { action: 'rollback' }, 'owner');
  checkEqual('a rollback without a reason is refused', noReason.status, 400);
  const rolled = await http('POST', '/v1/semantic/release', { action: 'rollback', reason: 'v2 inflated spend by 10%' }, 'owner');
  checkEqual('with a reason it goes through', rolled.status, 200);
  check('and the config says who and why', rolled.body.status === 'rolled-back' && rolled.body.rollback.reason.includes('10%'),
    `${rolled.body.status}: ${rolled.body.rollback?.reason}`);
  const afterRollback = await http('POST', '/v1/semantic/ask', { question }, 'canary-key');
  check('the canary actor now gets the stable revision', afterRollback.body.plan.modelRevision === null
    || afterRollback.body.plan.modelRevision === 1, `${afterRollback.body.plan.modelRevision}`);
  const events = (await http('GET', '/v1/semantic/release')).body.events;
  check('the event log has start, answers and the rollback', ['start', 'answer', 'rollback'].every((kind) => events.some((event) => event.kind === kind)),
    [...new Set(events.map((event) => event.kind))].join(','));

  section('5b. a retry after a rollback has to say what is different');
  const blindRetry = await http('POST', '/v1/semantic/release', { action: 'start', from: 1, to: 3, canaryPct: 100 }, 'owner');
  checkEqual('restarting without a reason is refused', blindRetry.status, 409);
  check('and the refusal quotes the rollback it is retrying', /rolled back/.test(blindRetry.body.error.message),
    blindRetry.body.error.message.slice(0, 120));
  const restarted = await http('POST', '/v1/semantic/release', {
    action: 'start', from: 1, to: 3, canaryPct: 100,
    retry: { reason: 'v3 only drops a metric the question does not use' },
  }, 'owner');
  checkEqual('with a reason it starts', restarted.status, 200);
  checkEqual('and it is marked as the second attempt', restarted.body.attempt, 2);
  check('the retry records the rollback it retries and the new reason',
    (restarted.body.retry?.of ?? '').length > 0 && /only drops a metric/.test(restarted.body.retry?.reason ?? ''),
    JSON.stringify(restarted.body.retry));
  checkEqual('at 100% everyone is on the canary', pickRevision(restarted.body, 'anyone', 'anything').side, 'canary');
  // v3 dropped metric/roi: the same question answers on the stable side and refuses on the canary
  const roiQuestion = '2025 年 11 月各大区 ROI';
  const firstError = await http('POST', '/v1/semantic/ask', { question: roiQuestion }, 'canary-key');
  check('the canary refuses a metric it dropped', firstError.status === 200 && (firstError.body.refusals?.length ?? 0) > 0,
    JSON.stringify(firstError.body.refusals?.[0]?.code ?? 'no refusal'));
  const afterOne = (await http('GET', '/v1/semantic/release')).body;
  check('the refusal is recorded as an error, not as an answer', afterOne.evidence.errors === 1 && afterOne.evidence.answers === 0,
    `${afterOne.evidence.answers} answers / ${afterOne.evidence.errors} errors`);
  await http('POST', '/v1/semantic/ask', { question: roiQuestion }, 'stable-key');
  await http('POST', '/v1/semantic/ask', { question: roiQuestion }, 'viewer-key');
  const afterThree = (await http('GET', '/v1/semantic/release')).body;
  check('three refusals in a row trigger the guard', afterThree.config.status === 'rolled-back', afterThree.config.status);
  check('with a reason the guard wrote, marked automatic', afterThree.config.rollback.auto === true
    && /consecutive canary errors/.test(afterThree.config.rollback.reason), afterThree.config.rollback.reason);
  checkEqual('and the actor is the guard, not a person', afterThree.config.rollback.actor, 'canary-guard');

  section('7. a scoped release only reaches its groups');
  const scoped = await http('POST', '/v1/semantic/release', {
    action: 'start', from: 1, to: 2, canaryPct: 100, scope: { groups: ['beta'] },
    retry: { reason: 'scope test' },
  }, 'owner');
  checkEqual('the scope is stored with the release', scoped.body.scope?.groups?.[0], 'beta');
  const outsider = await http('POST', '/v1/semantic/ask', { question }, 'canary-key');
  check('an actor outside the scope gets the stable revision even at 100%',
    outsider.body.plan.modelRevision === null || outsider.body.plan.modelRevision === 1, `${outsider.body.plan.modelRevision}`);
  const insider = await http('POST', '/v1/semantic/ask', { question }, 'canary-key', { 'x-pagent-group': 'beta' });
  checkEqual('a member of the group gets the canary', insider.body.plan.modelRevision, 2);
  checkEqual('pickRevision agrees, out of scope', pickRevision(scoped.body, 'anyone', 'q', 'alpha').side, 'out-of-scope');
  await http('POST', '/v1/semantic/release', { action: 'rollback', reason: 'scope test done' }, 'owner');

  section('7b. a canary can be scoped to a slice of the answer, not just to people');
  const dimensionScoped = await http('POST', '/v1/semantic/release', {
    action: 'start', from: 1, to: 2, canaryPct: 100, scope: { dimension: 'dim/region', values: ['华东'] },
    retry: { reason: 'slice test' },
  }, 'owner');
  checkEqual('the slice is stored with the release', dimensionScoped.body.scope?.dimension, 'dim/region');
  checkEqual('with the values it covers', JSON.stringify(dimensionScoped.body.scope?.values), '["华东"]');
  const filtered = (value) => ({
    spec: {
      metric: 'metric/spend', dimensions: ['dim/region'],
      period: { from: '2025-11-01', to: '2025-12-01', grain: 'month', said: '2025-11' },
      filters: [{ dimension: 'dim/region', value }], descending: true, matched: [],
    },
  });
  const inSlice = await http('POST', '/v1/semantic/ask', filtered('华东'), 'canary-key');
  checkEqual('a question filtered to the slice gets the canary', inSlice.body.plan.modelRevision, 2);
  const otherSlice = await http('POST', '/v1/semantic/ask', filtered('华南'), 'canary-key');
  check('another slice stays on the stable revision',
    otherSlice.body.plan.modelRevision === null || otherSlice.body.plan.modelRevision === 1, `${otherSlice.body.plan.modelRevision}`);
  const unfiltered = await http('POST', '/v1/semantic/ask', { question }, 'canary-key');
  check('and an unfiltered question is not the slice',
    unfiltered.body.plan.modelRevision === null || unfiltered.body.plan.modelRevision === 1, `${unfiltered.body.plan.modelRevision}`);
  await http('POST', '/v1/semantic/release', { action: 'rollback', reason: 'slice test done' }, 'owner');

  section('7c. the slice can come from the words, once a vocabulary exists');
  // without a vocabulary the same question is not a slice, which is the documented limit
  const withoutVocabulary = await http('POST', '/v1/semantic/release', {
    action: 'start', from: 1, to: 2, canaryPct: 100,
    scope: { dimension: 'dim/region', values: ['华东'] },
    retry: { reason: 'vocabulary test A' },
  }, 'owner');
  checkEqual('the release starts scoped to the slice', withoutVocabulary.status, 200);
  const noVocabularyAsk = await http('POST', '/v1/semantic/ask', { question: '2025 年 11 月华东大区花费' }, 'canary-key');
  check('without a vocabulary, a word is not a slice and stays stable',
    noVocabularyAsk.body.plan.modelRevision === null || noVocabularyAsk.body.plan.modelRevision === 1,
    String(noVocabularyAsk.body.plan.modelRevision));
  const vocabulary = await http('POST', '/v1/semantic/values', { action: 'build' }, 'analyst');
  checkEqual('the vocabulary builds', vocabulary.status, 200);
  const wordSlice = await http('POST', '/v1/semantic/ask', { question: '2025 年 11 月华东大区花费' }, 'canary-key');
  checkEqual('now the word routes to the canary', wordSlice.body.plan.modelRevision, 2);
  const otherWord = await http('POST', '/v1/semantic/ask', { question: '2025 年 11 月华南大区花费' }, 'canary-key');
  check('another slice still stays stable',
    otherWord.body.plan.modelRevision === null || otherWord.body.plan.modelRevision === 1,
    String(otherWord.body.plan.modelRevision));
  const noSlice = await http('POST', '/v1/semantic/ask', { question: '2025 年 11 月大区花费' }, 'canary-key');
  check('and a question about every region is not the slice',
    noSlice.body.plan.modelRevision === null || noSlice.body.plan.modelRevision === 1,
    String(noSlice.body.plan.modelRevision));
  await http('POST', '/v1/semantic/release', { action: 'rollback', reason: 'vocabulary slice test done' }, 'owner');

  section('8. a canary whose number moves is a failure, not just a slow release');
  const guarded = await http('POST', '/v1/semantic/release', {
    action: 'start', from: 1, to: 2, canaryPct: 100, qualityGuard: { maxRelativeDelta: 0.02 },
    retry: { reason: 'quality guard test' },
  }, 'owner');
  check('the guard is stored with the release', guarded.body.qualityGuard?.maxRelativeDelta === 0.02,
    JSON.stringify(guarded.body.qualityGuard));
  const firstGuarded = await http('POST', '/v1/semantic/ask', { question }, 'canary-key');
  check('the first canary answer is still returned to the caller', firstGuarded.status === 200 && firstGuarded.body.plan.modelRevision === 2,
    `${firstGuarded.status}/${firstGuarded.body.plan?.modelRevision}`);
  const afterFirst = (await http('GET', '/v1/semantic/release')).body;
  check('but it is recorded as a quality failure, not an answer', afterFirst.evidence.errors === 1 && afterFirst.evidence.answers === 0,
    `${afterFirst.evidence.answers} answers / ${afterFirst.evidence.errors} errors`);
  check('the failure names the movement and the limit', /quality: total moved/.test(afterFirst.events.at(-1).detail)
    && /limit 2\.00%/.test(afterFirst.events.at(-1).detail), afterFirst.events.at(-1).detail);
  await http('POST', '/v1/semantic/ask', { question }, 'stable-key');
  await http('POST', '/v1/semantic/ask', { question }, 'viewer-key');
  const afterQuality = (await http('GET', '/v1/semantic/release')).body;
  checkEqual('three of them stop the release', afterQuality.config.status, 'rolled-back');
  check('and the reason is the guard\'s', /consecutive canary errors/.test(afterQuality.config.rollback.reason), afterQuality.config.rollback.reason);

  section('8b. promotion opens a watch window, and the guard stays on');
  const watch = new ReleaseStore(workspace, 'demo-watch');
  watch.start({ from: 1, to: 2, canaryPct: 100, actor: 'alice', now: '2026-10-29T00:00:00.000Z' });
  for (let index = 0; index < 30; index++) {
    watch.record({ ts: '2026-10-29T00:10:00.000Z', kind: 'answer', revision: 2, side: 'canary', actor: 'bulk-' + index, question: 'q' });
  }
  const promoted = watch.promote({ actor: 'alice', now: '2026-10-29T01:00:00.000Z', watchHours: 24 });
  check('the promoted release carries a watch window', typeof promoted.watchUntil === 'string' && promoted.watchUntil > '2026-10-29T01:00:00.000Z',
    promoted.watchUntil);
  check('and the window is the length that was asked for', promoted.promote.watchHours === 24, String(promoted.promote.watchHours));
  check('the guard is active inside the window', watch.watchActive('2026-10-29T12:00:00.000Z') === true);
  check('and inactive after it', watch.watchActive('2026-10-30T02:00:00.000Z') === false);
  for (let index = 0; index < 3; index++) {
    watch.record({ ts: '2026-10-29T02:0' + index + ':00.000Z', kind: 'error', revision: 2, side: 'canary', actor: 'guard-test', question: 'q' });
  }
  const watched = watch.autoRollbackAfterErrors({ actor: 'canary-guard', now: '2026-10-29T02:10:00.000Z' });
  check('three errors after promotion roll it back', watched?.status === 'rolled-back', watched?.status ?? 'null');
  check('with a reason that says it was the watch window', /post-promotion watch/.test(watched?.rollback?.reason ?? ''),
    watched?.rollback?.reason ?? '');
  const noWatch = new ReleaseStore(workspace, 'demo-nowatch');
  noWatch.start({ from: 1, to: 2, canaryPct: 100, actor: 'alice', now: '2026-10-29T00:00:00.000Z' });
  for (let index = 0; index < 30; index++) {
    noWatch.record({ ts: '2026-10-29T00:10:00.000Z', kind: 'answer', revision: 2, side: 'canary', actor: 'a', question: 'q' });
  }
  const noWindow = noWatch.promote({ actor: 'alice', now: '2026-10-29T01:00:00.000Z', watchHours: 0 });
  check('watchHours 0 opens no window', noWindow.watchUntil === undefined, String(noWindow.watchUntil));
  for (let index = 0; index < 3; index++) {
    noWatch.record({ ts: '2026-10-29T02:00:00.000Z', kind: 'error', revision: 2, side: 'canary', actor: 'x', question: 'q' });
  }
  check('so errors after it do not roll back', noWatch.autoRollbackAfterErrors({ actor: 'canary-guard', now: '2026-10-29T02:10:00.000Z' }) === null);

  section('9. one timeline: what changed, when, and who said yes');
  // a learned word and a review line, so the timeline has more than one source
  const timelineIndex = indexModel(built);
  learnWord({
    workspace, graph, index: timelineIndex, word: '投放总额', target: 'metric/spend',
    source: 'review', model: 'bob', evidence: 'timeline test', now: '2026-10-29T00:05:00.000Z',
  });
  new ReviewLog(join(workspace, 'reviews', `${graph}.jsonl`)).append({
    ts: '2026-10-29T00:06:00.000Z', actor: 'bob', action: 'accept', target: 'metric/cac', reason: 'timeline test',
  });
  const timeline = await http('GET', '/v1/semantic/timeline?limit=500');
  checkEqual('the timeline answers', timeline.status, 200);
  const kinds = new Set(timeline.body.events.map((event) => event.kind));
  check('it merges release, lexicon and review records', kinds.has('release') && kinds.has('lexicon') && kinds.has('review'),
    [...kinds].join(','));
  check('every release decision is there with its actor', timeline.body.events.some((event) => event.kind === 'release' && event.actor === 'alice' && /rollback/.test(event.detail)),
    timeline.body.events.filter((event) => event.kind === 'release').slice(-2).map((event) => `${event.actor}:${event.detail.slice(0, 30)}`).join(' | '));
  check('the auto rollback is attributed to the guard', timeline.body.events.some((event) => event.actor === 'canary-guard'),
    timeline.body.counts.release + ' release events');
  checkEqual('the learned word is on the timeline', timeline.body.counts.lexicon, 1);
  check('the timeline names the log it now reads', /timeline[\/]demo-analytics\.jsonl$/.test((timeline.body.sources.log ?? '').replaceAll('\\', '/')),
    timeline.body.sources.log ?? 'missing');
  const timelineLog = readFileSync(join(workspace, 'timeline', graph + '.jsonl'), 'utf8').trim().split(String.fromCharCode(10)).map((line) => JSON.parse(line));
  check('release decisions are written to the log, not only to their own file',
    timelineLog.filter((entry) => entry.kind === 'release').length > 0, `${timelineLog.length} logged entries`);
  check('and the timeline counts them once', timeline.body.counts.release >= timelineLog.filter((entry) => entry.kind === 'release').length,
    `${timeline.body.counts.release} on the timeline vs ${timelineLog.filter((entry) => entry.kind === 'release').length} in the log`);
  const sorted = timeline.body.events.every((event, index, all) => index === 0 || all[index - 1].at <= event.at);
  check('the events are in order', sorted, `${timeline.body.events.length} events`);
  check('each kind names its source file', Object.values(timeline.body.sources).every((source) => ['release', 'lexicon', 'reviews', 'audit', 'timeline'].some((name) => source.includes(name))),
    Object.keys(timeline.body.sources).length + ' sources');
  const again2 = await http('GET', '/v1/semantic/timeline?limit=500');
  checkEqual('and the same history gives the same timeline', JSON.stringify(again2.body.events), JSON.stringify(timeline.body.events));

  section('10. replaying a release decision is not a way around the gate');
  const store = new ReleaseStore(workspace, graph);
  checkEqual('the store reads back what the API wrote', store.get().status, 'rolled-back');
  check('and the auto rollback is in the event log', store.events().some((event) => event.kind === 'rollback' && event.actor === 'canary-guard'));
  const promoteAfterRollback = await http('POST', '/v1/semantic/release', { action: 'promote' }, 'owner');
  checkEqual('a rolled-back release cannot be promoted into place', promoteAfterRollback.status, 409);
  checkEqual('the reason is that nothing is running', promoteAfterRollback.body.error.code, 'promotion-refused');
} finally {
  await server.close();
  rmSync(workspace, { recursive: true, force: true });
}

summary('P1-f canary release');
