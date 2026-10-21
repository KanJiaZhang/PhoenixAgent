#!/usr/bin/env node
/**
 * P4 / M5 acceptance: the attribution agent.
 *
 * Five claims, and the third is the one that separates this from a dashboard filter:
 *
 * 1. **The loop runs on the semantic model.** Drivers come from `contributesTo`, slices from `groupedBy`, and
 *    depth comes from the loop, not from a hard-coded query.
 * 2. **The decompositions are exact where the model supports one.** A ratio splits into its two factors with
 *    no residual; an additive metric's slices sum to the change; a driver the formula subtracts is subtracted.
 * 3. **What is not explained is said out loud.** Drop one driver and the residual shows up, with its share, in
 *    both the numbers and the narrative.
 * 4. **It refuses instead of inventing.** No driver for a drivers-mode request, no such metric, no budget left -
 *    each is a refusal with a hint, not a plausible story.
 * 5. **Batching is measured, and the run teaches the skill library.** A dimension costs one query, not one per
 *    slice; the lessons land in M4 with the numbers attached.
 */

import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkClose, checkEqual, section, summary } from './verify-lib.mjs';
import { readSqliteCatalog, sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { indexModel } from '../packages/semantic/src/sql.ts';
import { attribute } from '../packages/agents/attribution/src/index.ts';
import { GraphClient } from '../packages/core/src/graph-client.ts';
import { loadConfig } from '../packages/core/src/config.ts';
import { SkillStore } from '../packages/skills/src/types.ts';
import { harvestFromAttribution } from '../packages/skills/src/harvest.ts';
import { advise } from '../packages/skills/src/advise.ts';

const root = process.cwd();
const dbPath = join(root, 'fixtures', 'demo', 'data', 'demo.db');
const workspace = join(root, '.pag');
const graph = 'demo-analytics';
const modelPath = join(workspace, 'build', graph, 'candidates.json');
rmSync(join(root, '.pag-m5'), { recursive: true, force: true });

if (!existsSync(modelPath)) {
  execFileSync(process.execPath, ['packages/semantic/src/cli.ts', 'build', '--graph', graph,
    '--now', '2026-10-24T00:00:00.000Z', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const index = indexModel(JSON.parse(readFileSync(modelPath, 'utf8')).candidates);
const db = new DatabaseSync(dbPath, { readOnly: true });
const runner = sqliteRunner(db, { rowLimit: 1000, timeoutMs: 10_000 });
const run = (sql) => {
  assertReadOnly(sql);
  return runner(sql);
};

const explain = (result) => result.explanation ?? '';

// ---------------------------------------------------------------------------------------------------
section('1. the base case, through the base (integration)');
const client = new GraphClient(loadConfig().phoenix);
let online = true;
try {
  await client.health();
} catch {
  online = false;
}
if (online) {
  const base = await client.callTool('attribute_change', {
    graph: 'tpc-h-analytics', question: '1995 到 1996 年各地区营收为什么变化', mode: 'auto',
  });
  const text = JSON.stringify(base);
  check('the base reproduces its own attribution case (95,612,794.05 -> 98,879,432.89)',
    text.includes('95612794.05') && text.includes('98879432.89'),
    text.slice(0, 160));
  check('the delta it reports is +3,266,638.84', text.includes('3266638.84') || text.includes('3,266,638.84'),
    (text.match(/-?\d[\d,.]*/g) ?? []).slice(0, 8).join(', '));
  check('the base says its contributions add up', /贡献之和|合计|sum/i.test(text));
} else {
  check('SKIP: PhoenixGraph is not answering, the base integration check needs it', true, 'not reachable on :8081');
}

// ---------------------------------------------------------------------------------------------------
section('2. a ratio splits exactly into its two factors');
const roi = attribute({ metric: 'roi', from: '2025-10', to: '2025-11', index, run });
checkEqual('the decomposition is the ratio one', roi.root.decomposition, 'ratio');
checkEqual('both drivers are present', roi.root.drivers.length, 2);
const numerator = roi.root.drivers.find((driver) => driver.role === 'numerator');
const denominator = roi.root.drivers.find((driver) => driver.role === 'denominator');
check('the numerator and the denominator are identified from the formula',
  numerator?.metric === 'metric/revenue' && denominator?.metric === 'metric/spend',
  `${numerator?.metric} / ${denominator?.metric}`);
checkClose('the two effects add up to the change', numerator.contribution + denominator.contribution, roi.root.delta, 1e-9);
check('the exact decomposition leaves no residual', Math.abs(roi.root.unexplained.absolute) <= 1e-9,
  `${roi.root.unexplained.absolute}`);
check('the effects have opposite signs, which is why a share of the change is meaningless',
  numerator.contribution > 0 && denominator.contribution < 0,
  `${numerator.contribution} / ${denominator.contribution}`);
check('the drivers say their share is not meaningful',
  roi.root.drivers.every((driver) => driver.shareMeaningful === false));
check('the narrative says it is a decomposition, not a cause', /不是因果结论/.test(explain(roi)));
check('the narrative never claims causality', !/导致|因为|造成|致使/.test(explain(roi)),
  (explain(roi).match(/导致|因为|造成|致使/g) ?? []).join(','));

// ---------------------------------------------------------------------------------------------------
section('3. an additive metric: slices add up, and the loop drills');
const spend = attribute({ metric: 'spend', from: '2025-10', to: '2025-11', index, run });
checkEqual('the decomposition is additive', spend.root.decomposition, 'additive');
const regionSet = spend.root.sliceSets.find((set) => set.dimension === 'dim/region');
check('the region slices were computed in one query', regionSet !== undefined && regionSet.batchedQueries === 1,
  regionSet ? `${regionSet.items.length} slices, naive ${regionSet.naiveQueries}` : 'none');
const regionSum = regionSet.items.reduce((sum, item) => sum + item.delta, 0);
checkClose('the region slices sum to the change', regionSum, spend.root.delta, 1e-6);
check('batching replaces one query per slice per period',
  regionSet.naiveQueries === regionSet.items.length * 2 && regionSet.naiveQueries / regionSet.batchedQueries >= 5,
  `${regionSet.naiveQueries} naive vs 1 batched`);
check('the loop actually looped', spend.cost.iterations >= 2, `${spend.cost.iterations} iterations`);
check('the drill went at least two levels deep', spend.path.length >= 3 && spend.path[2].depth === 2,
  spend.path.map((node) => node.label ?? node.metric).join(' -> '));
check('the drilled subset carries a readable label', spend.path.slice(1).every((node) => node.label !== undefined),
  spend.path.map((node) => node.label ?? '-').join(' | '));
check('a drilled subset is a filtered query, and it runs', spend.path.slice(1).every((node) => node.queries >= 1),
  spend.path.map((node) => `${node.queries}q`).join(' '));
check('the whole loop stays inside its budget', spend.cost.queries <= 40 && spend.cost.ms < 5_000,
  `${spend.cost.queries} queries, ${spend.cost.ms} ms`);
check('the top slice is named in the narrative', /华东|华南|华北|西南/.test(explain(spend)));

// ---------------------------------------------------------------------------------------------------
section('4. what is not explained is reported, not absorbed');
const gmvFull = attribute({ metric: 'gmv', from: '2024-11', to: '2025-11', index, run });
checkEqual('the signed decomposition is additive', gmvFull.root.decomposition, 'additive');
checkClose('with both drivers the residual is zero', gmvFull.root.unexplained.absolute, 0, 1e-6);
const refunds = gmvFull.root.drivers.find((driver) => driver.metric === 'metric/refunded_amount');
check('the driver the formula subtracts is subtracted', refunds.sign === -1 && refunds.contribution < 0,
  `${refunds.metric} sign=${refunds.sign} contribution=${refunds.contribution}`);

const gmvPartial = attribute({
  metric: 'gmv', from: '2024-11', to: '2025-11', index, run, drivers: ['metric/paid_amount'],
});
check('dropping a driver downgrades nothing silently: it is still additive', gmvPartial.root.decomposition === 'additive');
check('the unexplained part is reported with its share',
  Math.abs(gmvPartial.root.unexplained.share) > 0.01 && Math.abs(gmvPartial.root.unexplained.share) < 0.5,
  `share ${(gmvPartial.root.unexplained.share * 100).toFixed(1)}%, absolute ${gmvPartial.root.unexplained.absolute}`);
check('the narrative states the unexplained part', /未被这次分解解释/.test(explain(gmvPartial)), explain(gmvPartial).split('\n').at(-2));
check('the confidence warns about it, too',
  gmvPartial.confidence.warnings.some((warning) => /unexplained|未解释/.test(warning)),
  gmvPartial.confidence.warnings.join(' | '));

// ---------------------------------------------------------------------------------------------------
section('5. refusals instead of stories');
const noDriver = attribute({ metric: 'clicks', from: '2025-10', to: '2025-11', index, run, mode: 'drivers' });
checkEqual('drivers mode without a contributesTo edge refuses', noDriver.refusals[0]?.code, 'not-in-model');
check('the refusal names what is missing and what to do', /contributesTo/.test(noDriver.refusals[0]?.message ?? '')
  && (noDriver.refusals[0]?.hint ?? '').length > 0, noDriver.refusals[0]?.message);
const unknown = attribute({ metric: 'does_not_exist', from: '2025-10', to: '2025-11', index, run });
checkEqual('an unknown metric refuses', unknown.refusals[0]?.code, 'no-such-metric');
const budget = attribute({ metric: 'spend', from: '2025-10', to: '2025-11', index, run, maxQueries: 1 });
checkEqual('an exhausted budget refuses instead of returning a partial tree', budget.refusals[0]?.code, 'budget');

// ---------------------------------------------------------------------------------------------------
section('6. the same question gets the same answer');
const repeat = attribute({ metric: 'spend', from: '2025-10', to: '2025-11', index, run });
check('the delta is identical', repeat.root.delta === spend.root.delta, `${repeat.root.delta}`);
check('the slice shares are identical',
  JSON.stringify(repeat.root.sliceSets.map((set) => set.items.map((item) => item.share)))
  === JSON.stringify(spend.root.sliceSets.map((set) => set.items.map((item) => item.share))));
check('the plan is identical, query for query',
  JSON.stringify(repeat.evidence.sql) === JSON.stringify(spend.evidence.sql), `${spend.evidence.sql.length} statements`);

// ---------------------------------------------------------------------------------------------------
section('7. the run teaches the skill library');
const store = new SkillStore(join(root, '.pag-m5', 'skills'));
const harvested = [
  ...harvestFromAttribution(store, roi, { actor: 'verifier', now: '2026-10-24T00:00:00.000Z' }),
  ...harvestFromAttribution(store, spend, { actor: 'verifier', now: '2026-10-24T00:00:00.000Z' }),
  ...harvestFromAttribution(store, gmvPartial, { actor: 'verifier', now: '2026-10-24T00:00:00.000Z' }),
];
check('the lessons were harvested', harvested.length >= 3, `${harvested.length} tips`);
check('every lesson carries the numbers that produced it',
  harvested.every((tip) => tip.evidence.some((evidence) => evidence.metrics !== undefined)),
  harvested.map((tip) => tip.id.split('/').pop()).join(', '));
check('a batching lesson exists, with both query counts',
  harvested.some((tip) => tip.statement.includes('GROUP BY') && tip.evidence[0]?.metrics?.naiveQueries !== undefined));
check('a residual lesson exists, with the share',
  harvested.some((tip) => /未解释/.test(tip.statement) && tip.evidence[0]?.metrics?.share !== undefined),
  harvested.filter((tip) => /未解释/.test(tip.statement)).map((tip) => tip.statement).join(' | '));
check('a ratio lesson exists', harvested.some((tip) => /分子|分母/.test(tip.statement)));
const advice = advise(store, 'attribution groupby spend ratio', { limit: 5 });
check('the lessons are retrievable by the skill layer', advice.advice.length > 0,
  advice.advice.map((entry) => entry.tip.id).join(', '));

// ---------------------------------------------------------------------------------------------------
section('8. the CLI is the same agent');
const cli = JSON.parse(execFileSync(process.execPath, [
  'packages/agents/attribution/src/cli.ts', '--metric', 'roi', '--from', '2025-10', '--to', '2025-11',
  '--graph', graph, '--workspace', workspace, '--json',
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
checkEqual('the CLI result matches the module result', cli.root.delta, roi.root.delta);
check('the CLI reports the same decomposition', cli.root.decomposition === 'ratio' && cli.root.drivers.length === 2);
check('the CLI carries the evidence SQL', Array.isArray(cli.evidence.sql) && cli.evidence.sql.length >= 2,
  `${cli.evidence.sql.length} statements`);

summary('M5');
