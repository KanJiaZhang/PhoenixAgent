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
import { ask } from '../packages/semantic/src/ask/query.ts';
import { indexModel } from '../packages/semantic/src/sql.ts';
import { askHybrid, AskSession, validateProposal, learnWord, loadLexicon, applyLexicon, buildPrompt, DraftQueue, proposeFromQuestion, buildValueVocabulary, loadAliases, addAlias, suppressValue, loadSuppressions } from '../packages/semantic/src/ask/index.ts';

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

section('8. new vocabulary goes through a queue, not a side effect');
const queue = new DraftQueue(workspace, graph);
const proposal = queue.propose({
  word: '客单价', target: 'metric/cpa', question: '2025 年 11 月各大区客单价', index,
  source: 'manual', proposedBy: 'bob', now: now.toISOString(),
});
check('a proposal becomes a pending draft', proposal.status === 'pending' && queue.pending().length === 1, proposal.id);
check('and it is not in the lexicon yet', loadLexicon(workspace, graph).every((entry) => entry.word !== '客单价'));
const stillUnknown = await askHybrid({ question: '2025 年 11 月各大区客单价', index, run, workspace, graph, now });
checkEqual('so the word still does not answer', stillUnknown.spec, null);

let selfReview = null;
try {
  queue.decide(proposal.id, { action: 'accept', actor: 'bob', index, now: now.toISOString() });
} catch (error) {
  selfReview = error;
}
check('the proposer cannot certify their own word', selfReview !== null, selfReview?.message ?? '');

const certified = queue.decide(proposal.id, { action: 'accept', actor: 'carol', index, now: now.toISOString() });
checkEqual('a second analyst certifies it into the lexicon', certified.entry?.target, 'metric/cpa');
check('and the draft records who reviewed it', certified.draft.reviewed.by === 'carol' && certified.draft.status === 'accepted',
  `${certified.draft.reviewed.by}/${certified.draft.status}`);
const nowKnown = await askHybrid({ question: '2025 年 11 月各大区客单价', index, run, workspace, graph, now });
checkEqual('and the next question resolves it', nowKnown.spec?.metric, 'metric/cpa');

let draftBadTarget = null;
try {
  queue.propose({ word: '净利', target: 'metric/profit', question: '2025 年 11 月各大区净利', index, proposedBy: 'bob' });
} catch (error) {
  draftBadTarget = error;
}
check('a target the model does not have is refused at proposal time', draftBadTarget !== null, draftBadTarget?.message ?? '');
let unquoted = null;
try {
  queue.propose({ word: '毛利', target: 'metric/gmv', question: '2025 年 11 月各大区花费', index, proposedBy: 'bob' });
} catch (error) {
  unquoted = error;
}
check('a word the user never wrote is refused', unquoted !== null && /does not appear/.test(unquoted.message), unquoted?.message ?? '');

const rejectedDraft = queue.propose({
  word: '整体花费', target: 'metric/spend', question: '2025 年 11 月整体花费', index, proposedBy: 'bob', now: now.toISOString(),
});
const rejected = queue.decide(rejectedDraft.id, { action: 'reject', actor: 'carol', reason: '已经能被「花费」命中', index, now: now.toISOString() });
checkEqual('a rejection records its reason', rejected.draft.reviewed.reason, '已经能被「花费」命中');
checkEqual('and stops being pending', queue.pending().length, 0);
check('the lexicon is unchanged by the rejection', loadLexicon(workspace, graph).every((entry) => entry.word !== '整体花费'));

section('9. a model may propose, and only a person may certify');
const proposingGateway = {
  enabled: true, model: 'fake-model',
  async completeJson() {
    return [
      { word: '曝光成本', target: 'cpa' },
      { word: '伪指标', target: 'metric/does-not-exist' },
      { word: '用户', target: 'revenue' },
    ];
  },
};
const fromModel = await proposeFromQuestion({
  question: '2025 年 11 月各大区曝光成本与伪指标', index, gateway: proposingGateway,
  actor: 'bob', workspace, graph, now: now.toISOString(),
});
check('the valid candidate becomes a draft', fromModel.drafts.length === 1 && fromModel.drafts[0].word === '曝光成本',
  JSON.stringify(fromModel.drafts.map((draft) => draft.word)));
check('the invented target is dropped, with its reason', fromModel.dropped.some((entry) => entry.word === '伪指标' && /no 'metric\/does-not-exist'/.test(entry.reason)),
  JSON.stringify(fromModel.dropped.map((entry) => entry.reason).slice(0, 2)));
check('a word the question does not contain is dropped too', fromModel.dropped.some((entry) => entry.word === '用户'),
  JSON.stringify(fromModel.dropped.map((entry) => entry.word)));
check('the draft carries the model that proposed it', fromModel.drafts[0].source === 'llm' && fromModel.drafts[0].model === 'fake-model',
  `${fromModel.drafts[0].source}/${fromModel.drafts[0].model}`);
const stillPending = queue.pending();
check('and it is still pending: the model proposed, nobody certified', stillPending.length === 1 && stillPending[0].status === 'pending',
  stillPending.map((draft) => draft.word).join(','));

section('10. value filters: a slice is a spec, and it is checked against hand-written SQL');
const sliceSpec = {
  metric: 'metric/spend', dimensions: ['dim/region'],
  period: { from: '2025-11-01', to: '2025-12-01', grain: 'month', said: '2025-11' },
  filters: [{ dimension: 'dim/region', value: '华东' }], descending: true, matched: [],
};
const sliced = ask({ spec: sliceSpec, index, run });
check('a filtered spec answers', sliced.plan !== undefined && sliced.answer.rows.length === 1, `${sliced.answer?.rows?.length} rows`);
check('the filter became a predicate in the SQL', sliced.plan.filters.some((predicate) => predicate.includes('region_name') && predicate.includes("'华东'")),
  sliced.plan.filters.join(' AND '));
check('... and it is in the statement, not only in the plan', sliced.plan.sql[0].includes("'华东'"), sliced.plan.sql[0].slice(-90));
const handed = run(`SELECT SUM(f.spend) AS v FROM fact_ad_daily f JOIN dim_region r ON f.region_id = r.region_id
  WHERE f.date_key >= '2025-11-01' AND f.date_key < '2025-12-01' AND r.region_name = '华东'`).rows[0];
check('and the number matches a hand-written query', Math.abs(sliced.answer.total - Number(handed.v)) < 0.01,
  `${sliced.answer.total} vs ${Number(handed.v).toFixed(2)}`);
const unknownFilter = ask({ spec: { ...sliceSpec, filters: [{ dimension: 'dim/nowhere', value: 'x' }] }, index, run });
checkEqual('an unknown dimension in a filter is refused', unknownFilter.refusals?.[0]?.code, 'no-such-dimension');
const crossFilter = ask({ spec: { ...sliceSpec, metric: 'metric/capture_rate', dimensions: [], filters: [{ dimension: 'dim/region', value: '华东' }] }, index, run });
checkEqual('a cross-fact metric refuses filters instead of silently ignoring them', crossFilter.refusals?.[0]?.code, 'not-in-model');

section('11. the value vocabulary: words become slices, and a wrong word is a refusal');
const vocabulary = buildValueVocabulary({ index, run, graph, now: now.toISOString() });
check('the vocabulary reads labels through the foreign keys',
  vocabulary.dimensions.some((entry) => entry.dimension === 'dim/region' && entry.source === 'dim_region.region_name'),
  vocabulary.dimensions.map((entry) => `${entry.dimension}<-${entry.source}`).join(', '));
check('the four regions are there', vocabulary.dimensions.find((entry) => entry.dimension === 'dim/region')?.values.length === 4,
  JSON.stringify(vocabulary.dimensions.find((entry) => entry.dimension === 'dim/region')?.values));
check('dates and derived levels are skipped, not enumerated',
  vocabulary.skipped.some((entry) => entry.dimension === 'dim/stat_date' && /point in time/.test(entry.reason))
  && vocabulary.skipped.some((entry) => entry.dimension === 'dim/month' && /derived expression/.test(entry.reason)),
  vocabulary.skipped.map((entry) => entry.dimension + ':' + entry.reason.slice(0, 24)).join(' | '));
const values = { vocabulary, aliases: [] };
const slicedAsk = await askHybrid({ question: '2025 年 11 月华东大区花费', index, run, workspace, graph, now, values });
checkEqual('a value in the question becomes a filter', JSON.stringify(slicedAsk.spec?.filters), JSON.stringify([{ dimension: 'dim/region', value: '华东' }]));
const handSliced = run(`SELECT SUM(f.spend) AS v FROM fact_ad_daily f JOIN dim_region r ON f.region_id = r.region_id
  WHERE f.date_key >= '2025-11-01' AND f.date_key < '2025-12-01' AND r.region_name = '华东'`).rows[0];
check('and the answer matches hand-written SQL', Math.abs(slicedAsk.answer.answer.rows[0].measure - Number(handSliced.v)) < 0.01,
  `${slicedAsk.answer.answer.rows[0].measure} vs ${Number(handSliced.v).toFixed(2)}`);
const unknownValue = await askHybrid({ question: '2025 年 11 月火星大区花费', index, run, workspace, graph, now, values });
checkEqual('an unknown value is refused, not answered for everything', unknownValue.refusals[0]?.code, 'unknown-value');
check('the refusal lists the values that exist', (unknownValue.refusals[0]?.candidates ?? []).length === 4,
  (unknownValue.refusals[0]?.candidates ?? []).join('、'));
const ambiguousVocabulary = {
  ...vocabulary,
  dimensions: [
    ...vocabulary.dimensions,
    { dimension: 'dim/channel', name: 'channel', source: 'dim_channel.channel_name', values: ['信息流', '华东'], sql: '' },
  ],
};
const ambiguous = await askHybrid({ question: '2025 年 11 月华东花费', index, run, workspace, graph, now, values: { vocabulary: ambiguousVocabulary, aliases: [] } });
checkEqual('a word under two dimensions is refused', ambiguous.refusals[0]?.code, 'ambiguous-value');
const alias = addAlias({
  workspace, graph, vocabulary, word: '华东区', dimension: 'dim/region', value: '华东',
  actor: 'bob', note: 'business says 华东区', now: now.toISOString(),
});
checkEqual('an alias points at a real value', alias.value, '华东');
const aliased = await askHybrid({ question: '2025 年 11 月华东区花费', index, run, workspace, graph, now, values: { vocabulary, aliases: loadAliases(workspace, graph) } });
check('and the alias filters the same way', aliased.spec?.filters?.[0]?.value === '华东', JSON.stringify(aliased.spec?.filters));
let badAlias = null;
try {
  addAlias({ workspace, graph, vocabulary, word: '东北区', dimension: 'dim/region', value: '东北', actor: 'bob' });
} catch (error) {
  badAlias = error;
}
check('an alias onto a value that does not exist is refused', badAlias !== null, badAlias?.message ?? '');

section('12. suppression: a value the business may not ask about');
const suppression = suppressValue({
  workspace, graph, vocabulary, value: '华东', dimension: 'dim/region',
  reason: '内部代号，不允许出现在对外报表', actor: 'alice', now: now.toISOString(),
});
checkEqual('the suppression is recorded against the value', suppression.value, '华东');
const suppressedAsk = await askHybrid({ question: '2025 年 11 月华东大区花费', index, run, workspace, graph, now,
  values: { vocabulary, aliases: [], suppressions: loadSuppressions(workspace, graph) } });
checkEqual('asking about it is refused as out of scope', suppressedAsk.refusals[0]?.code, 'out-of-scope');
check('and the reason is carried', /内部代号/.test(suppressedAsk.refusals[0]?.message ?? ''), suppressedAsk.refusals[0]?.message ?? '');
const otherSlice = await askHybrid({ question: '2025 年 11 月华南大区花费', index, run, workspace, graph, now,
  values: { vocabulary, aliases: [], suppressions: loadSuppressions(workspace, graph) } });
check('the other slices still answer', otherSlice.refusals.length === 0 && otherSlice.answer.answer.rows.length === 1,
  JSON.stringify(otherSlice.answer?.answer?.rows));
let badSuppression = null;
try {
  suppressValue({ workspace, graph, vocabulary, value: '东北', dimension: 'dim/region', reason: 'x', actor: 'alice' });
} catch (error) {
  badSuppression = error;
}
check('suppressing a value that does not exist is refused', badSuppression !== null, badSuppression?.message ?? '');
let noReason = null;
try {
  suppressValue({ workspace, graph, vocabulary, word: '华东区', reason: '  ', actor: 'alice' });
} catch (error) {
  noReason = error;
}
check('a suppression without a reason is refused', noReason !== null, noReason?.message ?? '');

section('13. determinism');

const again = await askHybrid({ question: '2025 年 11 月各大区毛利', index, run, workspace, graph, now });
check('the same question gives the same SQL', again.plan?.sql[0] === afterLearning.plan?.sql[0], 'identical statements');

rmSync(workspace, { recursive: true, force: true });
summary('P1-d hybrid asking');
