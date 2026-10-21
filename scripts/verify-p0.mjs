#!/usr/bin/env node
/**
 * P0 acceptance: the skeleton talks to the base, and the router decides by query structure.
 *
 * Four things are checked, and each one is a claim the plan makes:
 *
 * 1. **The tool catalogue is read, not restated.** 13 tools come from the running service, and every tool has
 *    a binding - so a client can actually call what is advertised.
 * 2. **A round trip works.** `ask_data` on the base's TPC-H semantic graph answers with a plan, rows and
 *    provenance. This is the "one call actually works end to end" gate.
 * 3. **The router routes by structure.** 43 labelled questions, at least 90% top-1, and the two ambiguous
 *    ones must come back as a clarification rather than a guess.
 * 4. **Offline is a real mode.** With `PAGENT_LLM=none` the gateway is disabled and the router still decides.
 */

import { check, checkEqual, section, summary, skip } from './verify-lib.mjs';
import { GraphClient } from '../packages/core/src/graph-client.ts';
import { loadConfig } from '../packages/core/src/config.ts';
import { createGateway } from '../packages/core/src/llm.ts';
import { route } from '../packages/core/src/router.ts';

const config = loadConfig();
const client = new GraphClient(config.phoenix);

// --- 1. the catalogue ---------------------------------------------------------------------------------
section('1. the base advertises its tools, and every tool has a binding');
let catalog;
try {
  catalog = await client.tools();
} catch (error) {
  skip(`PhoenixGraph is not answering at ${config.phoenix.baseUrl} (${error.message}); start it and re-run`);
}
const names = catalog.tools.map((tool) => tool.name);
check('the catalogue is not empty', names.length > 0, `${names.length} tools`);
check('every tool has a binding', catalog.tools.every((tool) => catalog.bindings[tool.name]),
  `${Object.keys(catalog.bindings).length} bindings for ${catalog.tools.length} tools`);
check('the data tools are advertised', ['ask_data', 'analyze_business', 'attribute_change', 'semantic_model']
  .every((name) => names.includes(name)), names.join(', '));
// Not an exact count: the base may add a tool, and this client must not need a code change when it does
// (that is the point of reading the catalogue). What matters is that the plan's tools are all there.
check('the catalogue still has at least the 13 tools the plan was written against', names.length >= 13,
  `${names.length} tools`);

// --- 2. one call, end to end --------------------------------------------------------------------------
section('2. ask_data round trip on the base semantic graph');
const answer = await client.callTool('ask_data', { graph: 'tpc-h-analytics', question: '1996 年各地区营收', mode: 'auto' });
check('the answer carries rows', Array.isArray(answer?.answer?.rows) && answer.answer.rows.length > 0,
  `${answer?.answer?.rows?.length ?? 0} rows`);
check('the answer carries the SQL it ran', typeof answer?.sql === 'string' && answer.sql.includes('SUM('),
  (answer?.sql ?? '').slice(0, 60));
check('the answer carries a plan with the metric and dimension',
  answer?.plan?.metric === 'metric/revenue' && answer?.plan?.dimension === 'dim/region',
  JSON.stringify(answer?.plan));
check('the answer carries provenance the reader can check',
  typeof answer?.provenance?.traversal === 'string' && answer.provenance.vertexType === 'Sale'
  && answer.provenance.rows === answer.answer.rows.length,
  answer?.provenance?.traversal);
check('the answer says how sure it is', typeof answer?.confidence?.score === 'number' && answer.confidence.matchedTerms.length > 0,
  JSON.stringify(answer?.confidence));
check('the answer refuses to invent a total', typeof answer?.answer?.total === 'number');

// --- 3. routing by structure --------------------------------------------------------------------------
section('3. the router routes by query structure');
/** [question, expected agent] — `null` means "refuse to choose and ask". */
const cases = [
  ['从表结构和 wiki 构建销售域的语义层', 'semantic'],
  ['这份 DDL 里的字段含义是什么，帮我做数据字典', 'semantic'],
  ['看一下指标血缘，哪些字段支撑了 GMV', 'semantic'],
  ['语义层的覆盖率现在是多高', 'semantic'],
  ['帮我审查一下口径冲突的指标定义', 'semantic'],
  ['从 ETL SQL 里抽取实体关系', 'semantic'],
  ['把 pdf 文档里的指标定义建进语义模型', 'semantic'],
  ['schema 里有哪些表，字段注释全吗', 'semantic'],
  ['帮我补全缺失的实体关系', 'semantic'],
  ['语义层里 dim/region 绑定到哪个属性', 'semantic'],

  ['5 月 GMV 为什么下降', 'attribution'],
  ['归因一下 ROI 的下滑原因', 'attribution'],
  ['华东收入增长是哪些行业驱动的', 'attribution'],
  ['哪个渠道的转化率拖累了整体', 'attribution'],
  ['解释一下 11 月花费上涨的原因', 'attribution'],
  ['为什么直播渠道的 ROI 变差', 'attribution'],
  ['GMV 同比下降了多少，是什么导致的', 'attribution'],
  ['分析一下新客数下滑的根因', 'attribution'],
  ['哪些大区的收入贡献波动最大，为什么', 'attribution'],
  ['花费涨了但转化没涨，为什么', 'attribution'],

  ['下个月预算应该怎么分配到各大区', 'campaign'],
  ['哪些行业应该加投，哪些应该降低投入', 'campaign'],
  ['投放 ROI 提升的空间在哪里', 'campaign'],
  ['华东和华南的投放预算该加还是该减', 'campaign'],
  ['帮我优化投放的渠道预算配比', 'campaign'],
  ['信息流渠道的边际 ROI 是多少，值得加投吗', 'campaign'],
  ['哪个地区投放产出比最高', 'campaign'],
  ['按行业拆一下投放效果', 'campaign'],
  ['砍掉哪些低效渠道能提高 ROI', 'campaign'],
  ['预算翻倍的话，哪个行业最值得投', 'campaign'],

  ['最近欺诈率上升，帮我找有效特征', 'risk'],
  ['合成一条新的风控规则并评估召回率', 'risk'],
  ['这个团伙套现的特征值有区分度吗', 'risk'],
  ['离线回测新规则的准确率和召回', 'risk'],
  ['薅羊毛用户的行为特征该怎么定阈值', 'risk'],
  ['黑产最近在哪些行业活动，规则要调整吗', 'risk'],
  ['反欺诈模型的分值对命中率有多少提升', 'risk'],
  ['风控策略的误杀率怎么降到 1%', 'risk'],

  ['2025 年各大区 GMV 是多少', 'ask'],
  ['按渠道统计一下月度花费', 'ask'],
  ['上个月的订单明细给我看一下', 'ask'],
  ['转化率的同比变化', 'ask'],
  ['最近 30 天的曝光和点击分布', 'ask'],

  // near-ties: the router must ask rather than pick
  ['统计各渠道的投放效果', null],
  ['看一下各行业的投放情况', null],
];

let correct = 0;
const misses = [];
const ambiguities = [];
for (const [question, expected] of cases) {
  const decision = route(question);
  if (expected === null) {
    ambiguities.push({ question, decision });
    continue;
  }
  if (decision.agent === expected) correct++;
  else misses.push(`${question} → ${decision.agent ?? 'clarify'} (expected ${expected})`);
}
const labelled = cases.length - ambiguities.length;
const accuracy = correct / labelled;
check('top-1 routing accuracy is at least 90%', accuracy >= 0.9,
  `${correct}/${labelled} = ${(accuracy * 100).toFixed(1)}%${misses.length ? `; misses: ${misses.slice(0, 6).join(' | ')}` : ''}`);
check('ambiguous questions are clarified, never guessed',
  ambiguities.every(({ decision }) => decision.agent === null && decision.clarification),
  ambiguities.map(({ question, decision }) => `${question} → ${decision.agent ?? 'clarify'}`).join(' | '));
check('a diagnostic question is never answered by the lookup agent',
  ['5 月 GMV 为什么下降', '解释一下 11 月花费上涨的原因'].every((question) => {
    const decision = route(question);
    return decision.agent !== 'ask';
  }));
check('the signature carries the structure, not just a label',
  route('为什么华东的 GMV 下降').signature.type === 'diagnostic' &&
  route('为什么华东的 GMV 下降').signature.asksWhy === true &&
  route('2025 年各大区 GMV 是多少').signature.metrics.includes('gmv') &&
  route('2025 年各大区 GMV 是多少').signature.dimensions.includes('region'));

// --- 4. offline mode ----------------------------------------------------------------------------------
section('4. offline mode is a mode, not a fallback');
const offline = createGateway({ provider: 'none', baseUrl: '', apiKey: '', model: 'none', timeoutMs: 1000 });
checkEqual('PAGENT_LLM=none disables the gateway', offline.enabled, false);
let threw = false;
try {
  await offline.complete({ system: '', user: '' });
} catch (error) {
  threw = error.name === 'LlmDisabled';
}
check('calling a disabled gateway throws LlmDisabled instead of pretending', threw);
check('routing still works with no model',
  route('哪些行业应该加投，哪些应该降低投入').agent === 'campaign');

summary('P0');
