#!/usr/bin/env node
/**
 * P3 / M4 acceptance: the skill library.
 *
 * Five claims:
 *
 * 1. **Tips come from runs.** Every harvested tip carries the measurement that produced it; a tip with no
 *    evidence is refused by the store, not filtered out later.
 * 2. **Status is earned.** A candidate becomes adopted only after two *independent* runs (the same run twice
 *    is not a confirmation), and two misses retire it. The log is append-only, so the history is the audit.
 * 3. **Retrieval is a measurement, and it degrades when you remove a tip.** Eight annotated queries are
 *    answered with the expected tip; removing one tip drops the score by exactly the cases that depended on
 *    it - which is what "leave-one-out" has to mean to be worth running.
 * 4. **Scope is a hard filter.** A `mysql` tip is invisible to a `sqlite` query and vice versa; a retired tip
 *    is invisible to everything.
 * 5. **The library is portable.** SKILL.md round-trips the adopted set.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkEqual, section, summary } from './verify-lib.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readSqliteCatalog } from '../packages/dataplane/src/sqlite.ts';
import { SqlWorkspace } from '../packages/sqllayer/src/steps.ts';
import { SkillStore, runId } from '../packages/skills/src/types.ts';
import { harvestFromPlan, harvestFromProbes } from '../packages/skills/src/harvest.ts';
import { advise } from '../packages/skills/src/advise.ts';
import { fromSkillMarkdown, toSkillMarkdown } from '../packages/skills/src/export.ts';

const root = process.cwd();
const work = join(root, '.pag-m4');
rmSync(work, { recursive: true, force: true });

const dbPath = join(root, 'fixtures', 'demo', 'data', 'demo.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
const catalog = readSqliteCatalog(db, dbPath);
const sqlWorkspace = new SqlWorkspace(join(work, 'sql'));
const store = new SkillStore(join(work, 'skills'));

// ---------------------------------------------------------------------------------------------------
section('1. tips are harvested from runs, and evidence is mandatory');
const queries = [
  "SELECT * FROM fact_order WHERE substr(order_date, 1, 7) = '2024-05'",
  "SELECT order_id FROM fact_order WHERE substr(order_date, 1, 4) = '2025'",
  "SELECT * FROM fact_ad_daily WHERE region_id = 1",
  "SELECT order_id FROM fact_order WHERE status = 'paid' OR region_id = 2",
  'SELECT o.order_id, r.region_name FROM fact_order o, dim_region r',
  'SELECT order_id FROM fact_order',
];
for (const sql of queries) {
  const plan = sqlWorkspace.plan(sql, {
    catalog, dbPath, actor: 'verifier', now: '2026-10-22T00:00:00.000Z', rowCountThreshold: 100,
  });
  harvestFromPlan(store, plan, { actor: 'verifier', dialect: 'sqlite', now: '2026-10-22T00:00:00.000Z' });
}

// the injected build is where semantic lessons come from: every failed probe is a lesson with numbers
// the semantic lessons come from the injected build; make this script self-sufficient about producing it
const injectedReportPath = join(root, '.pag', 'build', 'demo-semantics-injected', 'report.json');
if (!existsSync(injectedReportPath)) {
  execFileSync(process.execPath, ['packages/semantic/src/cli.ts', 'build', '--graph', 'demo-semantics-injected',
    '--injected', '--now', '2026-10-22T00:00:00.000Z', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const injected = JSON.parse(readFileSync(injectedReportPath, 'utf8'));
harvestFromProbes(store, injected, { actor: 'verifier', now: '2026-10-22T00:00:00.000Z' });

// a person may write one, but must attach evidence too
store.harvest({
  scope: { agent: 'attribution', shape: 'ratio-slice' },
  kind: 'check',
  statement: '比率指标（ROI/CPA/转化率）不能按切片加总，归因要先分解分子与分母两个基础指标',
  rationale: 'ratio 指标的 groupedBy 可加性探针会被跳过，任何"各渠道 ROI 之和等于总 ROI"的说法都是错的',
  applies: { keywords: ['roi', 'ratio'], rule: 'A01' },
  evidence: [{ runId: runId('human', 'ratio-additivity'), kind: 'human', detail: '从 verify:m2 的 groupedBy 探针跳过记录中得出' }],
  confidence: 0.9,
  createdBy: 'analyst@demo',
  now: '2026-10-22T00:00:00.000Z',
});

const tips = store.list();
check('at least ten tips were harvested', tips.length >= 10, `${tips.length} tips`);
check('every tip carries evidence', tips.every((tip) => tip.evidence.length > 0),
  tips.filter((tip) => tip.evidence.length === 0).map((tip) => tip.id).join(', '));
const rewriteTips = tips.filter((tip) => tip.kind === 'rewrite');
check('the rewrite tips carry the measurement that produced them',
  rewriteTips.length >= 1 && rewriteTips.every((tip) => tip.evidence.some((evidence) => evidence.metrics?.rowsAfter !== undefined)),
  rewriteTips.map((tip) => tip.evidence[0]?.detail).join(' | ').slice(0, 160));
check('the check tips carry the plan that showed them',
  tips.filter((tip) => tip.kind === 'check' && tip.scope.agent === 'sqllayer')
    .every((tip) => tip.evidence.some((evidence) => evidence.metrics?.rowsBefore !== undefined || evidence.kind === 'probe' || evidence.kind === 'human')),
  tips.filter((tip) => tip.kind === 'check' && tip.scope.agent === 'sqllayer').map((tip) => tip.id).join(', '));
void tips;
let refused = false;
try {
  store.harvest({
    scope: { agent: 'sqllayer', dialect: 'sqlite', shape: 'forged' },
    kind: 'rewrite',
    statement: 'a tip nobody measured',
    rationale: 'none',
    applies: { rule: 'P99' },
    evidence: [],
  });
} catch (error) {
  refused = /evidence/.test(error.message);
}
check('a tip with no evidence is refused', refused);

// ---------------------------------------------------------------------------------------------------
section('2. status is earned: two independent runs to adopt, two misses to retire');
// P03 on fact_order was seen by two different queries (month and year), so it is already adopted
const p03 = tips.find((tip) => tip.scope.agent === 'sqllayer' && tip.applies.rule === 'P03');
check('a shape seen twice is adopted', p03 !== undefined && p03.status === 'adopted',
  `${p03?.id} status=${p03?.status} confirmations=${p03?.confirmations.length}`);
checkEqual('the confirmations are distinct runs', new Set(p03.confirmations).size, p03.confirmations.length);

const beforeRepeat = store.get(p03.id);
store.confirm(p03.id, p03.confirmations[0], 'verifier', 'the same run again');
checkEqual('confirming with the same run changes nothing', store.get(p03.id).version, beforeRepeat.version);

const candidate = store.list({ status: 'candidate' })[0];
check('there is still a candidate to test', candidate !== undefined, candidate?.id);
const afterMiss1 = store.miss(candidate.id, runId('miss-1'), 'verifier', 'advice was wrong here');
checkEqual('one miss does not retire a tip', afterMiss1.status, 'candidate');
const afterMiss2 = store.miss(candidate.id, runId('miss-2'), 'verifier', 'wrong again');
checkEqual('two misses retire it', afterMiss2.status, 'deprecated');
const history = store.history(candidate.id);
checkEqual('the history is append-only, one line per version', history.length, candidate.version + 2);
check('the last history line is the current state',
  history[history.length - 1].status === 'deprecated' && history.at(-1).misses === 2,
  `v${history.at(-1).version} ${history.at(-1).status} misses=${history.at(-1).misses}`);

const humanTip = tips.find((tip) => tip.createdBy === 'analyst@demo' && tip.status !== 'deprecated');
check('a person can promote a tip directly', store.promote(humanTip.id, 'lead@demo', 'agreed in review').status === 'adopted');

// ---------------------------------------------------------------------------------------------------
section('3. retrieval is measurable, and removing a tip costs exactly what it supported');
const cases = [
  ["SELECT * FROM fact_order WHERE substr(order_date, 1, 7) = '2024-05'", 'P03'],
  ["SELECT order_id FROM fact_order WHERE substr(order_date, 1, 4) = '2025'", 'P03'],
  ['SELECT * FROM fact_ad_daily', 'P01'],
  ['SELECT order_id FROM fact_order', 'P13'],
  ["SELECT order_id FROM fact_order WHERE status = 'paid' OR region_id = 2", 'P04'],
  ['SELECT o.order_id, r.region_name FROM fact_order o, dim_region r', 'P06'],
  ["SELECT COUNT(*) FROM fact_ad_daily WHERE region_id = 1", 'P02'],
  ["SELECT SUM(o.amount - o.refund_amount) FROM fact_order o WHERE o.status = 'paidd'", 'status'],
];
const expectedTip = (rule, sql) => {
  const appliesToQuery = (tip) => !tip.scope.table || sql.toLowerCase().includes(tip.scope.table.toLowerCase());
  if (rule === 'status') {
    return store.list().find((tip) => tip.scope.agent === 'semantic'
      && tip.applies.keywords?.includes('status') && appliesToQuery(tip));
  }
  const candidates = store.list().filter((tip) => tip.scope.agent === 'sqllayer'
    && tip.applies.rule === rule && tip.status !== 'deprecated' && appliesToQuery(tip)
    && (tip.scope.dialect === undefined || tip.scope.dialect === 'sqlite'));
  return candidates.find((tip) => tip.status === 'adopted') ?? candidates[0];
};

const hitWith = (exclude) => {
  let hits = 0;
  for (const [sql, rule] of cases) {
    const expected = expectedTip(rule, sql);
    if (!expected) continue;
    const result = advise(store, sql, { dialect: 'sqlite', catalog, limit: 3, exclude, rowCountThreshold: 100 });
    if (result.advice.some((entry) => entry.tip.id === expected.id)) hits++;
  }
  return hits;
};

const full = hitWith([]);
checkEqual('all eight annotated queries get their tip', full, cases.length);
const withoutP03 = hitWith([p03.id]);
check('removing the P03 tip costs the cases it alone supported', withoutP03 === full - 2,
  `${full} with the tip, ${withoutP03} without`);
const withoutAll = hitWith(store.list().map((tip) => tip.id));
checkEqual('removing everything leaves nothing', withoutAll, 0);

// scope is a filter, not a ranking
const mysqlTip = store.harvest({
  scope: { agent: 'sqllayer', dialect: 'mysql', shape: 'date-prefix' },
  kind: 'rewrite',
  statement: 'P03 mysql: 日期前缀改写成半开区间，MySQL 上还能命中索引条件下推',
  rationale: 'MySQL 的索引条件下推对范围谓词有效',
  applies: { rule: 'P03' },
  evidence: [{ runId: runId('mysql', 'plan'), kind: 'plan', detail: 'measured on a MySQL grammar' }],
  confidence: 0.8,
  createdBy: 'verifier',
});
const sqliteAdvice = advise(store, "SELECT * FROM fact_order WHERE substr(order_date,1,7)='2024-05'", { dialect: 'sqlite', catalog, limit: 5, rowCountThreshold: 100 });
const mysqlAdvice = advise(store, "SELECT * FROM fact_order WHERE substr(order_date,1,7)='2024-05'", { dialect: 'mysql', catalog, limit: 5, rowCountThreshold: 100 });
check('a mysql tip never reaches a sqlite query', !sqliteAdvice.advice.some((entry) => entry.tip.id === mysqlTip.id),
  sqliteAdvice.advice.map((entry) => entry.tip.id).join(', '));
check('the same tip is offered when the dialect matches', mysqlAdvice.advice.some((entry) => entry.tip.id === mysqlTip.id),
  mysqlAdvice.advice.map((entry) => entry.tip.id).join(', '));
check('a retired tip is invisible', !advise(store, "SELECT * FROM fact_order WHERE substr(order_date,1,7)='2024-05'",
  { dialect: 'sqlite', catalog, limit: 5, exclude: [], rowCountThreshold: 100 }).advice.some((entry) => entry.tip.id === candidate.id));

// ordering: an adopted tip outranks a candidate that matches the same query
const alt = store.harvest({
  scope: { agent: 'sqllayer', dialect: 'sqlite', shape: 'date-prefix-alt' },
  kind: 'prefer',
  statement: 'dates: 也可以把日期前缀换成日期维度（dim/month），那样计划里根本不会出现 substr',
  rationale: '换成维度列后谓词直接落在日期列上',
  applies: { keywords: ['substr', 'order_date'] },
  evidence: [{ runId: runId('alt', 'plan'), kind: 'plan', detail: 'observed while rewriting the same query' }],
  confidence: 0.7,
  createdBy: 'verifier',
});
const ordered = advise(store, "SELECT * FROM fact_order WHERE substr(order_date,1,7)='2024-05'", { dialect: 'sqlite', catalog, limit: 6, rowCountThreshold: 100 });
const firstCandidate = ordered.advice.findIndex((entry) => entry.tip.status === 'candidate');
check('adopted tips rank above candidates',
  ordered.advice[0].tip.id === p03.id && firstCandidate > 0
  && ordered.advice.slice(0, firstCandidate).every((entry) => entry.tip.status === 'adopted'),
  ordered.advice.map((entry) => `${entry.tip.status}:${entry.score}`).join(', '));
check('a keyword-matched candidate is still offered, just lower', ordered.advice.some((entry) => entry.tip.id === alt.id),
  `limit 5, candidates present: ${ordered.advice.filter((entry) => entry.tip.status === 'candidate').length}`);
check('the advice explains why it matched', ordered.advice.every((entry) => entry.why.length > 0),
  ordered.advice.map((entry) => entry.why).join(' | '));

// ---------------------------------------------------------------------------------------------------
section('4. the library is portable');
const adopted = store.list({ status: 'adopted' });
const markdown = toSkillMarkdown(store.list(), {
  name: 'phoenixagent-skills',
  description: 'harvested tips',
  generatedAt: '2026-10-22T00:00:00.000Z',
});
check('the export states how many tips and how many are adopted',
  markdown.includes(`tips: ${store.list().length}`) && markdown.includes(`adopted: ${adopted.length}`),
  markdown.split('\n').slice(0, 8).join(' | '));
const parsed = fromSkillMarkdown(markdown);
checkEqual('every tip survives the round trip', parsed.tips.length, store.list().length);
check('ids and statements come back unchanged',
  parsed.tips.every((tip) => {
    const original = store.get(tip.id);
    return original.statement === tip.statement;
  }),
  parsed.tips.filter((tip) => store.get(tip.id).statement !== tip.statement).map((tip) => tip.id).join(', '));
check('scope survives the round trip', parsed.tips.every((tip) => {
  const original = store.get(tip.id);
  return original.scope.dialect === tip.scope.dialect && original.scope.agent === tip.scope.agent;
}));

// ---------------------------------------------------------------------------------------------------
section('5. the CLI is the same library');
const listed = JSON.parse(execFileSync(process.execPath, [
  'packages/skills/src/cli.ts', 'list', '--workspace', work, '--json',
], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
checkEqual('the CLI lists the same tips', listed.length, store.list().length);
const advised = JSON.parse(execFileSync(process.execPath, [
  'packages/skills/src/cli.ts', 'advise', '--sql',
  "SELECT * FROM fact_order WHERE substr(order_date,1,7)='2024-05'", '--dialect', 'sqlite',
  '--workspace', work, '--json',
], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
check('the CLI advises with the same retrieval', advised.advice.length > 0 && advised.advice[0].id === p03.id,
  advised.advice.map((entry) => entry.id).join(', '));

summary('M4');
