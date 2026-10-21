#!/usr/bin/env node
/**
 * P1 acceptance for the semantic agent (M2). Four claims, each checked against real runs:
 *
 * 1. **A model can be built from the assets an enterprise already has** - DDL, ETL SQL, wiki - with every
 *    claim traceable to a character range in a source, and with accuracy and coverage reported.
 * 2. **The probes catch injected mistakes** - a wrong FK, a typo'd column in a metric, and a contradicting
 *    document - and a contradiction goes to the review queue instead of being silently resolved.
 * 3. **A person can change the model, and the model has history** - edits are appended, published revisions
 *    are snapshots, and a replay of an old revision answers with the old definition.
 * 4. **The same inputs give the same report** - the build is deterministic, which is what makes the numbers
 *    above diffable between runs.
 *
 * The publish half needs PhoenixGraph on :8081 (it writes a real graph and reads it back by id). Without it
 * the script says so and skips rather than pretending.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkEqual, checkClose, section, summary, skip } from './verify-lib.mjs';
import { GraphClient } from '../packages/core/src/graph-client.ts';
import { loadConfig } from '../packages/core/src/config.ts';

const root = process.cwd();
const workspace = join(root, '.pag');
const NOW = '2026-10-20T00:00:00.000Z';
const CLEAN = 'demo-semantics';
const INJECTED = 'demo-semantics-injected';

rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });

function run(args, expectFailure = false) {
  try {
    const stdout = execFileSync(process.execPath, ['packages/semantic/src/cli.ts', ...args], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (expectFailure) {
      return { failed: true, code: error.status, stdout: error.stdout, stderr: error.stderr };
    }
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    throw error;
  }
}

const goldens = JSON.parse(readFileSync(join(root, 'fixtures', 'demo', 'goldens.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------------
section('1. build from DDL + ETL SQL + wiki, with evidence and two numbers');
const clean = run(['build', '--graph', CLEAN, '--now', NOW, '--json']);
const report = clean.report ?? clean;

check('the gate passes on a clean fixture set', report.gate.passed,
  report.gate.reasons.slice(0, 3).join(' | ') || 'no reasons');
check('metrics were extracted from the ETL corpus', report.entities.metric.total >= 10,
  `${report.entities.metric.total} metrics`);
check('foreign keys became references and were probed', report.relations.references.probed >= 5
  && report.relations.references.accuracy === 1, JSON.stringify(report.relations.references));
check('GROUP BY became groupedBy and was probed additive', report.relations.groupedBy.probed >= 10
  && report.relations.groupedBy.accuracy === 1, JSON.stringify(report.relations.groupedBy));
check('the document contributed attribution edges', report.relations.contributesTo.probed >= 2,
  JSON.stringify(report.relations.contributesTo));
check('metric accuracy is 100% on what was probed', report.entities.metric.accuracy === 1,
  JSON.stringify(report.entities.metric));
check('column documentation coverage clears the floor', report.coverage.columnsDocumented >= 0.8,
  `${(report.coverage.columnsDocumented * 100).toFixed(1)}%`);
check('every metric has an executable definition', report.coverage.metricsWithDefinition >= 0.9,
  `${(report.coverage.metricsWithDefinition * 100).toFixed(1)}%`);

const buildArtifact = JSON.parse(readFileSync(join(workspace, 'build', CLEAN, 'candidates.json'), 'utf8'));
const live = buildArtifact.candidates.filter((candidate) => candidate.status !== 'rejected');
const withoutEvidence = live.filter((candidate) => !candidate.evidence?.length
  || candidate.evidence.some((item) => !item.quote || !item.sourceFile));
check('every candidate cites a source file and a quote', withoutEvidence.length === 0,
  withoutEvidence.slice(0, 3).map((candidate) => candidate.id).join(', '));
const withSpan = live.filter((candidate) => candidate.evidence.some((item) => Array.isArray(item.span) && item.span[1] > item.span[0]));
check('most claims carry a character range, not just a filename', withSpan.length / live.length > 0.6,
  `${withSpan.length}/${live.length}`);
const docGaps = live.filter((candidate) => candidate.status === 'needs_review');
check('the PDF text layer was read, not skipped', report.sourceFiles.some((file) => file.kind === 'pdf')
  && clean.unread.length === 0, `${report.sourceFiles.length} sources read, ${clean.unread.length} unread`);
const pdfEvidence = live.filter((candidate) => candidate.evidence.some((item) => item.kind === 'pdf'));
check('the PDF contributed to the model, with its own evidence kind', pdfEvidence.length >= 3,
  `${pdfEvidence.length} candidates cite the PDF: ${pdfEvidence.slice(0, 4).map((candidate) => candidate.id).join(', ')}`);
check('a view became a query with derivedFrom edges', live.some((candidate) => candidate.entityType === 'query'
  && candidate.payload.kind === 'view') && report.relations.derivedFrom.total === 3,
  `${report.relations.derivedFrom.total} derivedFrom edges`);
check('the ETL load became a writes edge', report.relations.writes.total === 1,
  JSON.stringify(live.find((candidate) => candidate.relationType === 'writes')?.id));
check('the domain from the document front matter exists', live.some((candidate) => candidate.entityType === 'domain'
  && candidate.id.startsWith('domain/')), live.filter((candidate) => candidate.entityType === 'domain').map((candidate) => candidate.id).join(', '));
check('domain membership and headline metrics are relations', report.relations.belongsTo.total >= 8
  && report.relations.hasMetric.total >= 4, `belongsTo ${report.relations.belongsTo.total}, hasMetric ${report.relations.hasMetric.total}`);
check('time levels form a hierarchy', report.relations.hierarchy.total === 3,
  `${report.relations.hierarchy.total} hierarchy edges`);
check('the grain was executed, not assumed', report.probes.some((probe) => probe.id === 'grain:table/fact_ad_daily'
  && probe.status === 'pass'), report.probes.find((probe) => probe.id === 'grain:table/fact_ad_daily')?.detail);
const discovered = live.filter((candidate) => candidate.relationType === 'references'
  && candidate.payload?.declaredBy === 'discovered');
const discoveredValidated = discovered.filter((candidate) => report.probes.some(
  (probe) => probe.id === `references:${candidate.id}` && probe.status === 'pass'));
check('an undeclared foreign key was discovered and validated', discoveredValidated.length >= 1,
  discoveredValidated.map((candidate) => candidate.id).join(', '));
check('a discovered FK on an empty table is reported as unproven, not as passing',
  discovered.some((candidate) => report.probes.some((probe) => probe.id === `references:${candidate.id}`
    && probe.status === 'skipped')),
  discovered.map((candidate) => candidate.id).join(', '));
check('every catalog table has a completeness entry', report.completeness.length === report.entities.table.total,
  report.completeness.map((entry) => `${entry.table} ${entry.score}`).join(' · '));
check('the fact table is complete by the four criteria',
  report.completeness.find((entry) => entry.table === 'fact_ad_daily')?.score === 1,
  JSON.stringify(report.completeness.find((entry) => entry.table === 'fact_ad_daily')));
check('the ontology covers more than extraction produced', Object.keys(report.relationInventory).length >= 12,
  Object.keys(report.relationInventory).join(', '));
check('a document name nothing computes is surfaced, not dropped',
  docGaps.some((candidate) => candidate.id === 'metric/cac'),
  docGaps.map((candidate) => candidate.id).join(', '));

// ---------------------------------------------------------------------------------------------------
section('2. injected mistakes are caught, and a contradiction is not resolved by the machine');
const injected = run(['build', '--graph', INJECTED, '--injected', '--now', NOW, '--json']);
const injectedReport = injected.report ?? injected;
check('the gate refuses the injected build', injectedReport.gate.passed === false);
const reasons = injectedReport.gate.reasons.join(' | ');
check('the typo in a metric expression fails its compile probe',
  /metric\/revenue_typo failed: no such column/.test(reasons), reasons.slice(0, 200));
check('the wrong foreign key fails its join probe at 0%',
  /references.*failed: 0\/\d+ child rows/.test(reasons), reasons.slice(0, 200));
check('the contradicting GMV definition is reported as a conflict',
  injectedReport.conflicts.some((line) => /metric\/gmv/.test(line) && /定义/.test(line)),
  injectedReport.conflicts.join(' | ').slice(0, 200));
check('the conflict names both sides', injectedReport.conflicts.some((line) => /SUM\(amount\)/.test(line) && /refund_amount/.test(line)),
  injectedReport.conflicts[0]?.slice(0, 220) ?? '');

// ---------------------------------------------------------------------------------------------------
section('3. the same inputs produce the same report');
const second = run(['build', '--graph', CLEAN, '--now', NOW, '--json']);
// drift is by definition the difference to the previous build, so it is not part of "same inputs, same report"
const strip = (value) => JSON.stringify({ ...value, generatedAt: undefined, drift: undefined });
check('two builds of the same fixtures agree byte for byte', strip(second.report ?? second) === strip(report));

// ---------------------------------------------------------------------------------------------------
section('4. publish v1, review three things, publish v2, replay both');
const client = new GraphClient(loadConfig().phoenix);
let online = true;
try {
  await client.health();
} catch {
  online = false;
}
if (!online) skip('PhoenixGraph is not answering; the publish/replay half needs it (start tools/start-phoenixgraph.sh)');

const v1 = run(['publish', '--graph', CLEAN, '--now', '2026-10-20T01:00:00.000Z', '--json']);
checkEqual("publish v1 reads every node back", v1.checks.failures.length, 0);
check('publish v1 wrote the whole model', v1.vertices >= 50 && v1.edges >= 150,
  `${v1.vertices} vertices, ${v1.edges} edges, ${v1.checks.vertexReads} read back, ${v1.checks.edgeReads} traversed`);
checkClose('the published revision records the GMV it answers', v1.values['metric/gmv'], goldens.metrics.gmv, 1e-9);
check('publish v2 exports an analytical copy for the RocksDB load path', existsSync(v1.analyticalExport));
const exported = JSON.parse(readFileSync(v1.analyticalExport, 'utf8'));
checkEqual('the analytical copy is a RocksDB-Edge graph', exported.schema.storage.type, 'RocksDB-Edge');
check('the analytical copy carries every node and edge',
  exported.vertices.length === v1.vertices && exported.edges.length === v1.edges,
  `${exported.vertices.length}/${v1.vertices} vertices`);

// --- three human decisions: a correction, a removal, an addition
const humanMetric = {
  id: 'metric/net_revenue',
  kind: 'entity',
  entityType: 'metric',
  payload: {
    name: 'net_revenue',
    expression: 'SUM(fact_ad_daily.revenue - fact_ad_daily.spend)',
    aggFunction: 'SUM',
    metricKind: 'base',
    description: '净收入：归因收入减投放花费',
    tables: ['fact_ad_daily'],
    columns: ['fact_ad_daily.revenue', 'fact_ad_daily.spend'],
    filters: [],
  },
  evidence: [{ kind: 'human', sourceFile: '(human)', quote: '净收入 = 归因收入 - 投放花费', span: [0, 26] }],
  confidence: 1,
};
const humanPath = join(workspace, 'human-metric.json');
writeFileSync(humanPath, JSON.stringify(humanMetric, null, 2));

const reviewed = run([
  'review', '--graph', CLEAN, '--now', '2026-10-20T02:00:00.000Z', '--json',
  '--actor', 'analyst@demo',
  '--edit', 'metric/gmv', '--set', 'payload.description=已支付订单应付金额扣减退款（人工确认口径）',
  '--reason', '口径按 wiki 第二版修正',
  '--reject', 'metric/cac', '--reason', '没有 ETL 或报表支撑，先不进入模型',
  '--add', humanPath,
]);
checkEqual('three decisions were appended to the log', reviewed.revisions.length, 3);
check('the review log keeps what was rejected', reviewed.revisions.some((revision) => revision.action === 'reject'
  && revision.target === 'metric/cac'));
const reviewedReport = reviewed.report;
check('the model still passes the gate after the decisions', reviewedReport.gate.passed,
  reviewedReport.gate.reasons.slice(0, 2).join(' | '));
check('the rejected metric is no longer in the model', !reviewedReport.probes.some((probe) => probe.target === 'metric/cac'
  && probe.status !== 'skipped'));

const v2 = run(['publish', '--graph', CLEAN, '--now', '2026-10-20T03:00:00.000Z', '--json']);
checkEqual('publish v2 reads every node back', v2.checks.failures.length, 0);
checkEqual('the new revision is v2', v2.version, 2);
checkEqual('the dropped metric is tombstoned, not silently deleted', v2.tombstoned, 1);
const tombstone = await client.query(CLEAN, "g.V('metric/cac','Node').values('status')");
check('the tombstone says why it is gone', JSON.stringify(tombstone).includes('rejected'), JSON.stringify(tombstone));
check('the human metric is published in v2', v2.values['metric/net_revenue'] !== undefined,
  `${v2.values['metric/net_revenue']}`);
checkClose('net_revenue is revenue minus spend as the person defined it',
  v2.values['metric/net_revenue'], goldens.metrics.revenue - goldens.metrics.spend, 1e-9);

// --- replay: an old revision must answer with its own definition
const replay1 = run(['replay', '--graph', CLEAN, '--version', '1', '--metric', 'metric/gmv', '--json']);
checkClose('replaying v1 gives the number v1 recorded', replay1.value, v1.values['metric/gmv'], 1e-9);
check('replaying v1 re-runs the SQL rather than reading a cached number',
  replay1.sql.includes('SUM(') && replay1.matchesRecorded === true, replay1.sql);
const replay2 = run(['replay', '--graph', CLEAN, '--version', '2', '--metric', 'metric/net_revenue', '--json']);
checkClose('replaying v2 finds the metric added later', replay2.value, v2.values['metric/net_revenue'], 1e-9);
const absent = run(['replay', '--graph', CLEAN, '--version', '1', '--metric', 'metric/net_revenue', '--json'], true);
check('v1 has no net_revenue to replay', /no metric/.test(absent.stdout ?? ''),
  (absent.stdout ?? '').slice(0, 120));

// --- the graph itself is the model, not a copy of it
const vertex = await client.query(CLEAN, "g.V('metric/net_revenue','Node').elementMap()");
check('the base can read the added metric by id', vertex.length === 1
  && String(vertex[0]?.expression).includes('revenue'), JSON.stringify(vertex[0]?.expression ?? null));
const edges = await client.query(CLEAN, "g.V('metric/gmv','Node').outE().filter(relation.equals('usesColumn')).otherV().values('name')");
check('the base can traverse the metric lineage', edges.length >= 2, `${edges.length} columns`);
const incoming = await client.query(CLEAN, "g.V('metric/roi','Node').inE().filter(relation.equals('contributesTo')).otherV().values('name')");
check('the attribution edges survived the write', incoming.length >= 2, JSON.stringify(incoming));

summary('P1 / M2');
