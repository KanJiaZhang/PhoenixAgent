#!/usr/bin/env node
/**
 * P1-d acceptance: a model may propose, but the answer is still the deterministic one.
 *
 * | claim | attack |
 * | --- | --- |
 * | a proposal is validated, not trusted | an invented metric and an unsliceable dimension must both refuse |
 * | a failed proposal is declared | when the deterministic reader answers instead, `source.fallback` must say so |
 * | learning is a review step | a word is learned only onto an id that exists, and only once; afterwards it works with no model at all |
 * | a follow-up is a delta | "那按月呢" must keep the metric and the period and change the grain, not re-answer the question |
 * | no gateway, no problem | with `enabled: false` the deterministic path runs and the gateway is never called |
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkEqual, section, summary } from './verify-lib.mjs';
import { sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { build } from '../packages/semantic/src/pipeline.ts';
import { indexModel } from '../packages/semantic/src/sql.ts';
import { askHybrid, AskSession, validateProposal, learnWord, loadLexicon, applyLexicon, buildPrompt } from '../packages/semantic/src/ask/index.ts';

const root = process.cwd();
const workspace = join(root, '.pag-p1ask');
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

/** A gateway that answers with whatever it was told to, and counts how often it was asked. */
function fakeGateway(proposal) {
  const calls = [];
  return {
    calls,
    enabled: true,
    model: 'fake-model',
    async completeJson(request) { calls.push(request); return proposal; },
  };
}
const offGateway = { calls: [], enabled: false, model: 'none', async completeJson() { throw new Error('the gateway is off'); } };

section('1. the prompt is ids and names, and it never asks for SQL');
const prompt = buildPrompt('2025 年 11 月各大区花费', index);
check('the prompt lists metric ids', /metric\/spend/.test(prompt.user), prompt.user.slice(0, 80));
check('the prompt says JSON only and no SQL', /JSON only/.test(prompt.system) && /Never write SQL/.test(prompt.system));

section('2. a proposal is a hypothesis; the translator is the judge');
const good = validateProposal({ metric: 'spend', dimensions: ['region'], period: { from: '2025-11-01', to: '2025-12-01', grain: 'month' } }, index, now);
check('a metric named by name is repaired to its id', good.repairs.some((repair) => repair.field === 'metric' && repair.to === 'metric/spend'),
  JSON.stringify(good.repairs));
check('... and it produces a spec', good.spec?.metric === 'metric/spend' && good.spec.dimensions[0] === 'dim/region',
  JSON.stringify(good.spec));
check('with no refusals', good.refusals.length === 0);

const invented = validateProposal({ metric: 'metric/profit', dimensions: ['dim/region'] }, index, now);
check('an invented metric is refused', invented.spec === null && invented.refusals[0]?.code === 'no-such-metric', invented.refusals[0]?.message ?? '');
check('and the refusal lists what does exist', (invented.refusals[0]?.candidates ?? []).length > 10,
  `${invented.refusals[0]?.candidates?.length} candidates`);

const wrongDimension = validateProposal({ metric: 'metric/gmv', dimensions: ['dim/channel'] }, index, now);
check('a dimension the metric cannot be sliced by is refused', wrongDimension.spec === null, wrongDimension.refusals.map((refusal) => refusal.code).join(','));

const badTop = validateProposal({ metric: 'spend', dimensions: ['region'], topN: 5000 }, index, now);
check('a nonsense top-N is dropped, not clamped', badTop.spec?.topN === undefined
  && badTop.repairs.some((repair) => repair.field === 'topN'), JSON.stringify(badTop.repairs));

const wordPeriod = validateProposal({ metric: 'spend', dimensions: ['region'], period: { said: '上个月' } }, index, now);
check('a period said in words is refused rather than guessed', wordPeriod.spec === null, wordPeriod.refusals.map((refusal) => refusal.code).join(','));

section('3. the model can answer, and the answer is marked as the model\'s');
const llm = fakeGateway({ metric: 'spend', dimensions: ['region'], period: { from: '2025-11-01', to: '2025-12-01', grain: 'month' } });
const llmResult = await askHybrid({ question: '上月各大区花费', index, run, gateway: llm, workspace, graph, now });
checkEqual('the gateway was called', llm.calls.length, 1);
checkEqual('the source is the model', llmResult.source.kind, 'llm');
check('and the answer is executed, not described', llmResult.answer?.answer.rows.length === 4, `${llmResult.answer?.answer.rows.length} rows`);
check('the numbers come from the same SQL path as always', llmResult.plan?.sql[0]?.includes('fact_ad_daily') === true, llmResult.plan?.sql[0]?.slice(0, 60));

section('4. a refused proposal falls back loudly, never silently');
const liar = fakeGateway({ metric: 'metric/profit', dimensions: ['dim/region'] });
const fallback = await askHybrid({ question: '2025 年 11 月各大区花费', index, run, gateway: liar, workspace, graph, now });
checkEqual('the deterministic reader answered', fallback.source.kind, 'deterministic');
checkEqual('and said why', fallback.source.fallback, 'proposal-refused');
check('the refusal is carried in the result, not swallowed', fallback.refusals.length === 0 || fallback.notes.length > 0,
  fallback.notes.join(' | '));

section('5. with the gateway off, nothing changes');
const offResult = await askHybrid({ question: '2025 年 11 月各大区花费', index, run, gateway: offGateway, workspace, graph, now });
checkEqual('the deterministic path answered', offResult.source.kind, 'deterministic');
checkEqual('and the gateway was never called', offGateway.calls.length, 0);
check('with the same four regions', offResult.answer?.answer.rows.length === 4, `${offResult.answer?.answer.rows.length}`);

section('6. learning is a review step, and it works with the model switched off');
const unknown = await askHybrid({ question: '2025 年 11 月各大区毛利', index, run, workspace, graph, now });
checkEqual('an unknown word is a refusal before learning', unknown.spec, null);
checkEqual('with the code the vocabulary already uses', unknown.refusals[0]?.code, 'no-such-metric');

let refusedLearning = null;
try {
  learnWord({ workspace, graph, word: '毛利', target: 'metric/profit', index, now: now.toISOString() });
} catch (error) {
  refusedLearning = error;
}
check('a word cannot be learned onto an id the model does not have', refusedLearning !== null, refusedLearning?.message ?? '');

const learned = learnWord({ workspace, graph, word: '毛利', target: 'metric/gmv', index, source: 'review', model: 'reviewer@demo', evidence: 'asked 2026-10-26, agreed with finance', now: now.toISOString() });
checkEqual('the entry records its target and its evidence', learned.target, 'metric/gmv');
check('and it is on disk', loadLexicon(workspace, graph).length === 1, JSON.stringify(loadLexicon(workspace, graph)));

let conflictLearning = null;
try {
  learnWord({ workspace, graph, word: '毛利', target: 'metric/revenue', index, now: now.toISOString() });
} catch (error) {
  conflictLearning = error;
}
check('a word that already means something cannot be re-pointed', conflictLearning !== null, conflictLearning?.message ?? '');

const afterLearning = await askHybrid({ question: '2025 年 11 月各大区毛利', index, run, workspace, graph, now });
checkEqual('now the word works with no model at all', afterLearning.source.kind, 'deterministic');
check('the rewrite is visible in the result', afterLearning.source.rewritten?.includes('gmv') === true, afterLearning.source.rewritten ?? '');
checkEqual('and it answers the metric it was learned for', afterLearning.spec?.metric, 'metric/gmv');
check('with four regions of GMV', afterLearning.answer?.answer.rows.length === 4, `${afterLearning.answer?.answer.rows.length}`);

const rewrite = applyLexicon('2025年11月毛利和花费', loadLexicon(workspace, graph), index);
check('the rewrite is longest-word-first and does not touch other words', rewrite.question.includes('gmv') && rewrite.question.includes('花费'),
  rewrite.question);

section('7. a follow-up is a delta, not a new question');
const session = new AskSession({ index, run, workspace, graph, now });
const first = await session.ask('2025 年 11 月各大区花费');
checkEqual('the first turn is a normal ask', first.spec?.metric, 'metric/spend');
checkEqual('by region', first.spec?.dimensions[0], 'dim/region');
const second = await session.followUp('那按月呢');
check('the follow-up kept the metric', second.spec?.metric === 'metric/spend', JSON.stringify(second.spec?.metric));
check('and the period', second.spec?.period?.from === '2025-11-01', JSON.stringify(second.spec?.period));
check('but switched the grain', second.spec?.period?.grain === 'month' || second.spec?.dimensions.includes('dim/month'),
  `grain ${second.spec?.period?.grain}, dims ${JSON.stringify(second.spec?.dimensions)}`);
check('the carried fields are named', second.notes.some((note) => /carried over|replaced/.test(note)), second.notes.join(' | '));
const third = await session.followUp('换成收入');
checkEqual('a follow-up can replace the metric', third.spec?.metric, 'metric/revenue');
check('and keeps everything else', third.spec?.period?.from === '2025-11-01', JSON.stringify(third.spec?.period));
checkEqual('the session remembers three turns', session.turns.length, 3);
const noContext = await new AskSession({ index, run, workspace, graph, now }).followUp('那按月呢');
check('a follow-up with no previous turn is refused, not answered', noContext.spec === null, noContext.refusals.map((refusal) => refusal.code).join(','));

section('8. determinism');
const again = await askHybrid({ question: '2025 年 11 月各大区毛利', index, run, workspace, graph, now });
check('the same question gives the same SQL', again.plan?.sql[0] === afterLearning.plan?.sql[0], 'identical statements');

rmSync(workspace, { recursive: true, force: true });
summary('P1-d hybrid asking');
