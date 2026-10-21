#!/usr/bin/env node
/**
 * The semantic agent's command line: build, report, review, publish, replay.
 *
 * The CLI is the P1 product surface, and it is deliberately the same functions the HTTP API will call in P2.
 * Two commands carry the whole argument of this phase:
 *
 * - `build` prints the two numbers (accuracy and coverage) *and* the reasons the gate refused, never only a
 *   verdict. A model that cannot be published has to say what would make it publishable.
 * - `replay` renders and runs a metric from a published revision, which is how "this number came from model
 *   v2" stops being a claim and becomes a command anybody can run.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../../core/src/config.ts';
import { GraphClient } from '../../core/src/graph-client.ts';
import { ensureDir, readJson, writeJson } from '../../core/src/workspace.ts';
import { sqliteRunner } from '../../dataplane/src/sqlite.ts';
import { assertReadOnly } from '../../dataplane/src/guard.ts';
import { buildModel, build, loadBuild, rebuildReport, nextModelVersion, type BuildOptions } from './pipeline.ts';
import { ReviewLog, humanCandidate } from './review.ts';
import { indexModel, renderTotal } from './sql.ts';
import { ask, translate } from './ask/index.ts';
import { publish, exportAnalytical } from './publish.ts';
import type { MergedCandidate } from './merge.ts';
import type { Revision } from '../../contracts/src/index.ts';

interface Flags {
  command: string;
  graph: string;
  fixtures: string;
  workspace: string;
  now: string;
  injected: boolean;
  json: boolean;
  force: boolean;
  actor: string;
  reason: string;
  accept: string[];
  reject: string[];
  edits: { id: string; sets: string[] }[];
  resolve: string[];
  add: string[];
  version?: number;
  metric?: string;
  question?: string;
}

function parseFlags(argv: string[]): Flags {
  const config = loadConfig();
  const flags: Flags = {
    command: argv[0] ?? 'build',
    graph: 'demo-analytics',
    fixtures: config.fixtures,
    workspace: config.workspace,
    now: process.env.PAGENT_BUILD_TIME ?? new Date().toISOString(),
    injected: false,
    json: false,
    force: false,
    actor: process.env.PAGENT_ACTOR ?? 'cli',
    reason: '',
    accept: [],
    reject: [],
    edits: [],
    resolve: [],
    add: [],
  };
  let currentEdit: { id: string; sets: string[] } | null = null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--graph': flags.graph = value(); break;
      case '--fixtures': flags.fixtures = value(); break;
      case '--workspace': flags.workspace = value(); break;
      case '--now': flags.now = value(); break;
      case '--injected': flags.injected = true; break;
      case '--json': flags.json = true; break;
      case '--force': flags.force = true; break;
      case '--actor': flags.actor = value(); break;
      case '--reason': flags.reason = value(); break;
      case '--accept': flags.accept.push(value()); break;
      case '--reject': flags.reject.push(value()); break;
      case '--resolve': flags.resolve.push(value()); break;
      case '--add': flags.add.push(value()); break;
      case '--edit': currentEdit = { id: value(), sets: [] }; flags.edits.push(currentEdit); break;
      case '--set': {
        if (!currentEdit) throw new Error('--set must follow --edit <id>');
        currentEdit.sets.push(value());
        break;
      }
      case '--version': flags.version = Number(value()); break;
      case '--metric': flags.metric = value(); break;
      case '--question': flags.question = value(); break;
      case '--help': flags.command = 'help'; break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

function buildOptions(flags: Flags): BuildOptions {
  return {
    fixtures: flags.fixtures,
    graph: flags.graph,
    workspace: flags.workspace,
    now: flags.now,
    includeInjected: flags.injected,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const options = buildOptions(flags);
  ensureDir(options.workspace);

  switch (flags.command) {
    case 'build': {
      const outcome = build({ ...options, includeInjected: flags.injected });
      print(outcome, flags.json);
      break;
    }
    case 'report': {
      const outcome = rebuildReport(options);
      print(outcome, flags.json, true);
      break;
    }
    case 'review': {
      const log = new ReviewLog(join(options.workspace, 'reviews', `${options.graph}.jsonl`));
      const appended: Revision[] = [];
      for (const id of flags.accept) {
        appended.push(log.append({ ts: flags.now, actor: flags.actor, action: 'accept', target: id, reason: flags.reason || 'accepted after review' }));
      }
      for (const id of flags.reject) {
        appended.push(log.append({ ts: flags.now, actor: flags.actor, action: 'reject', target: id, reason: flags.reason || 'rejected after review' }));
      }
      for (const edit of flags.edits) {
        const patch: Record<string, unknown> = {};
        for (const assignment of edit.sets) {
          const equals = assignment.indexOf('=');
          if (equals < 0) throw new Error(`--set needs path=value, got '${assignment}'`);
          patch[assignment.slice(0, equals)] = parseValue(assignment.slice(equals + 1));
        }
        appended.push(log.append({ ts: flags.now, actor: flags.actor, action: 'edit', target: edit.id, reason: flags.reason || 'edited after review', patch }));
      }
      for (const id of flags.resolve) {
        appended.push(log.append({ ts: flags.now, actor: flags.actor, action: 'resolve-conflict', target: id, reason: flags.reason || 'conflict resolved' }));
      }
      for (const file of flags.add) {
        const candidate = readJson<MergedCandidate>(file) ?? JSON.parse(file) as MergedCandidate;
        const human = humanCandidate(candidate as unknown as Parameters<typeof humanCandidate>[0]);
        appended.push(log.append({ ts: flags.now, actor: flags.actor, action: 'add', target: human.id, reason: flags.reason || 'added by a person', patch: human as unknown as Record<string, unknown> }));
      }
      const outcome = rebuildReport(options);
      if (flags.json) {
        console.log(JSON.stringify({ revisions: appended, report: outcome.report }, null, 2));
      } else {
        for (const revision of appended) console.log(`revision #${revision.revision}: ${revision.action} ${revision.target}`);
        print(outcome, false, true);
      }
      break;
    }
    case 'publish': {
      const outcome = rebuildReport(options);
      if (!outcome.report.gate.passed && !flags.force) {
        console.error('the gate refused to publish:');
        for (const reason of outcome.report.gate.reasons) console.error(`  - ${reason}`);
        console.error('fix the reasons, or pass --force to publish anyway (it will be recorded)');
        process.exitCode = 1;
        return;
      }
      const client = new GraphClient(loadConfig().phoenix);
      const revision = nextModelVersion(options.workspace, options.graph);
      const previous = readJson<{ candidates: MergedCandidate[] }>(
        join(options.workspace, 'models', options.graph, `v${revision - 1}.json`));
      const result = await publish(client, {
        graph: options.graph,
        candidates: outcome.reviewed,
        revision,
        previousCandidates: previous?.candidates,
        log: (line) => console.error(`  ${line}`),
      });

      // what this revision answers, recorded so a replay can be compared against it later
      const values = measure(options, outcome.reviewed);
      const snapshotPath = join(options.workspace, 'models', options.graph, `v${revision}.json`);
      writeJson(snapshotPath, {
        graph: options.graph,
        version: revision,
        publishedAt: flags.now,
        gate: outcome.report.gate,
        checks: result.checks,
        candidates: outcome.reviewed.filter((candidate) => candidate.status !== 'rejected'),
        values,
      });
      // the analytical copy, for the RocksDB load path the base's semantic reader needs (see docs/P1-NOTES.md)
      const exportPath = join(options.workspace, 'models', options.graph, `v${revision}.graph.json`);
      writeJson(exportPath, exportAnalytical(options.graph, outcome.reviewed, revision));
      new ReviewLog(join(options.workspace, 'reviews', `${options.graph}.jsonl`)).append({
        ts: flags.now, actor: flags.actor, action: 'publish', target: options.graph,
        reason: flags.reason || `published v${revision}`, patch: { version: revision, forced: !outcome.report.gate.passed },
      });

      const summary = {
        version: revision, ...result, values, gatePassed: outcome.report.gate.passed,
        snapshot: snapshotPath, analyticalExport: exportPath,
      };
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`published v${revision} -> graph '${options.graph}': ${result.vertices} vertices, ${result.edges} edges, ${result.tombstoned} tombstoned`);
        console.log(`read back by id: ${result.checks.vertexReads} node(s), ${result.checks.edgeReads} edge traversal(s), ${result.checks.failures.length} failure(s)`);
        console.log(`analytical copy (RocksDB-Edge): ${exportPath}`);
        console.log(`gate: ${outcome.report.gate.passed ? 'passed' : 'FORCED (gate had reasons)'}`);
      }
      break;
    }
    case 'replay': {
      const version = flags.version ?? nextModelVersion(options.workspace, options.graph) - 1;
      const snapshot = readJson<{ candidates: MergedCandidate[]; values?: Record<string, number> }>(
        join(options.workspace, 'models', options.graph, `v${version}.json`));
      if (!snapshot) throw new Error(`no published revision v${version} for '${options.graph}'`);
      const index = indexModel(snapshot.candidates);
      const metricId = flags.metric ?? 'metric/gmv';
      const metric = index.metrics.find((entry) => entry.id === metricId || entry.payload.name === metricId);
      if (!metric) {
        const answer = { graph: options.graph, version, metric: metricId, refusal: `revision v${version} has no metric '${metricId}'` };
        if (flags.json) console.log(JSON.stringify(answer, null, 2));
        else console.log(answer.refusal);
        process.exitCode = 2;
        return;
      }
      const rendered = renderTotal(index, metric.id);
      const db = new DatabaseSync(join(options.fixtures, 'data', 'demo.db'), { readOnly: true });
      try {
        const run = sqliteRunner(db, { rowLimit: 10, timeoutMs: 30_000 });
        assertReadOnly(rendered.sql);
        const result = run(rendered.sql);
        const value = Number(result.rows[0]?.value ?? NaN);
        const answer = {
          graph: options.graph, version, metric: metric.id,
          sql: rendered.sql,
          value,
          recordedAtPublish: snapshot.values?.[metric.id],
          matchesRecorded: snapshot.values?.[metric.id] === undefined ? null : Math.abs(snapshot.values[metric.id]! - value) < 1e-9,
        };
        if (flags.json) console.log(JSON.stringify(answer, null, 2));
        else console.log(`${metric.id} @ v${version} = ${value}\n${rendered.sql}`);
      } finally {
        db.close();
      }
      break;
    }
    case 'ask':
    case 'translate': {
      const graph = flags.graph;
      const stored = loadBuild({ fixtures: flags.fixtures, graph, workspace: flags.workspace, now: flags.now });
      if (!stored) throw new Error(`no build for '${graph}'; run build first`);
      const index = indexModel(stored.candidates);
      const question = flags.question ?? flags.metric;
      if (!question) throw new Error(`${flags.command} needs --question "..."`);
      const db = new DatabaseSync(join(flags.fixtures, 'data', 'demo.db'), { readOnly: true });
      try {
        const run = sqliteRunner(db, { rowLimit: 1000, timeoutMs: 10_000 });
        const guarded = (sql: string) => {
          assertReadOnly(sql);
          return run(sql);
        };
        if (flags.command === 'translate') {
          const translated = translate({ question, index, now: new Date(flags.now) });
          if (flags.json) console.log(JSON.stringify(translated, null, 2));
          else if (translated.plan) {
            console.log(translated.plan.sql[0]);
            console.log(`
-- spec: ${JSON.stringify(translated.plan.spec)}`);
            for (const finding of translated.plan.findings) console.log(`-- ${finding.rule} ${finding.severity}: ${finding.message}`);
          } else for (const refusal of translated.refusals) console.log(`refusal ${refusal.code}: ${refusal.message}`);
          break;
        }
        const answer = ask({ question, index, run: guarded, now: new Date(flags.now) });
        if (flags.json) {
          console.log(JSON.stringify(answer, null, 2));
        } else if ('answer' in answer) {
          console.log(answer.answer.rows.length > 1
            ? answer.answer.rows.map((row) => `${String(row.value)}  ${row.measure}`).join(' | ')
            : `${answer.answer.total}`);
          console.log(`total ${answer.answer.total}${answer.answer.partial ? '（前 N 项之和）' : ''}`
            + `${answer.answer.compared ? ` · 对比 ${(answer.answer.compared.deltaPct * 100).toFixed(2)}%` : ''}`);
          console.log(`-- ${answer.plan.sql[0]}`);
        } else for (const refusal of answer.refusals) console.log(`refusal ${refusal.code}: ${refusal.message}`);
      } finally {
        db.close();
      }
      break;
    }
    case 'show': {
      const report = readJson<{ gate?: { passed: boolean; reasons: string[] }; coverage?: unknown }>(
        join(options.workspace, 'build', options.graph, 'report.json'));
      if (!report) throw new Error(`no report for '${options.graph}'; run build first`);
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    case 'help':
    default:
      console.log(`usage: semantic <build|report|review|publish|replay> [flags]

  build      extract, merge, probe, evaluate (writes .pag/build/<graph>/)
  report     re-evaluate the stored build with the review log applied
  review     --accept <id> --reject <id> --edit <id> --set payload.description=... --resolve <id> --add <file>
  publish    write the model into PhoenixGraph and snapshot the revision
  replay     --version <n> [--metric metric/gmv] render and run a metric from that revision
  ask        --question "2025 年 11 月各大区花费" [--json]   interpret + execute with provenance
  translate  --question "..." [--json]                          SQL only, no execution`);
      break;
  }
}

function measure(options: BuildOptions, candidates: MergedCandidate[]): Record<string, number> {
  const index = indexModel(candidates);
  const values: Record<string, number> = {};
  const db = new DatabaseSync(join(options.fixtures, 'data', 'demo.db'), { readOnly: true });
  try {
    const run = sqliteRunner(db, { rowLimit: 10, timeoutMs: 30_000 });
    for (const metric of index.metrics) {
      try {
        const rendered = renderTotal(index, metric.id);
        assertReadOnly(rendered.sql);
        const result = run(rendered.sql);
        const value = Number(result.rows[0]?.value ?? NaN);
        if (Number.isFinite(value)) values[metric.id] = value;
      } catch {
        // a metric that cannot be measured is absent from the snapshot, which the replay reports as a mismatch
      }
    }
  } finally {
    db.close();
  }
  return values;
}

function parseValue(text: string): unknown {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('[') || text.startsWith('{')) return JSON.parse(text);
  return text;
}

function print(outcome: ReturnType<typeof buildModel>, json: boolean, quiet = false): void {
  if (json) {
    console.log(JSON.stringify({
      graph: outcome.graph,
      modelVersion: outcome.modelVersion,
      gate: outcome.report.gate,
      coverage: outcome.report.coverage,
      entities: outcome.report.entities,
      relations: outcome.report.relations,
      conflicts: outcome.report.conflicts,
      completeness: outcome.report.completeness,
      relationInventory: outcome.report.relationInventory,
      orphans: outcome.report.orphans,
      drift: outcome.report.drift,
      unread: outcome.unread,
      sourceFiles: outcome.report.sourceFiles,
      notes: outcome.report.notes,
      probes: outcome.report.probes.map((probe) => ({ id: probe.id, status: probe.status, value: probe.value, detail: probe.detail })),
    }, null, 2));
    return;
  }

  console.log(`\n${outcome.graph}  (draft v${outcome.modelVersion})`);
  console.log(`  entities: ${table(outcome.report.entities)}`);
  console.log(`  relations: ${table(outcome.report.relations)}`);
  const coverage = outcome.report.coverage;
  console.log(`  coverage: tables ${pct(coverage.tables)} · columns ${pct(coverage.columns)}`
    + ` · documented ${pct(coverage.columnsDocumented)} · metrics ${pct(coverage.metricsWithDefinition)}`
    + ` · join pairs ${coverage.joinPairsValidated}/${coverage.joinPairs}`);
  const inventory = Object.entries(outcome.report.relationInventory)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} ${count}`)
    .join(' · ');
  console.log(`  ontology: ${inventory}`);
  const lowest = outcome.report.completeness.slice(0, 3)
    .map((entry) => `${entry.table} ${pct(entry.score)}`)
    .join(' · ');
  console.log(`  weakest tables: ${lowest}${outcome.report.orphans.length > 0 ? ` · orphans: ${outcome.report.orphans.join(', ')}` : ''}`);
  if (outcome.report.drift) {
    const drift = outcome.report.drift;
    console.log(`  drift since last build: +${drift.added.length} ~${drift.changed.length} -${drift.removed.length}`);
  }
  if (outcome.unread.length > 0) {
    console.log(`  unread sources: ${outcome.unread.map((entry) => entry.path).join(', ')}`);
  }
  console.log(`  gate: ${outcome.report.gate.passed ? 'PASS' : 'FAIL'}`);
  for (const reason of outcome.report.gate.reasons) console.log(`    - ${reason}`);
  if (!quiet) {
    for (const note of outcome.report.notes.slice(0, 6)) console.log(`    ~ ${note}`);
    const needsReview = outcome.reviewed.filter((candidate) => candidate.status === 'needs_review');
    if (needsReview.length > 0) {
      console.log(`  needs review (${needsReview.length}):`);
      for (const candidate of needsReview.slice(0, 10)) console.log(`    ? ${candidate.id} — ${candidate.note ?? ''}`);
    }
  }
}

function table(tallies: Record<string, { total: number; probed: number; passed: number; weak: number; failed: number; accuracy: number | null }>): string {
  return Object.entries(tallies)
    .filter(([, tally]) => tally.total > 0)
    .map(([type, tally]) => `${type} ${tally.passed}/${tally.probed}${tally.accuracy === null ? ' (n/a)' : ` (${(tally.accuracy * 100).toFixed(1)}%)`}`)
    .join(' · ');
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
