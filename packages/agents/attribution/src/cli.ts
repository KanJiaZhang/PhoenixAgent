#!/usr/bin/env node
/**
 * `attribute` on the command line: the M5 agent, runnable by a person.
 *
 * Reads the semantic model from a build (`--graph`), runs the loop against the demo warehouse, prints either
 * the narrative or the JSON, and can harvest the lessons into the skill library (`--harvest`). The narrative is
 * the default because it is the artefact a business reader gets; the JSON is for the caller that chains this
 * into another agent.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readJson } from '../../../core/src/workspace.ts';
import { loadConfig } from '../../../core/src/config.ts';
import { readSqliteCatalog, sqliteRunner } from '../../../dataplane/src/sqlite.ts';
import { assertReadOnly } from '../../../dataplane/src/guard.ts';
import { indexModel } from '../../../semantic/src/sql.ts';
import { SkillStore } from '../../../skills/src/types.ts';
import { harvestFromAttribution } from '../../../skills/src/harvest.ts';
import { attribute } from './loop.ts';
import { summarize } from './narrate.ts';
import type { MergedCandidate } from '../../../semantic/src/merge.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const json = argv.includes('--json');

const config = loadConfig();
const fixtures = flag('fixtures') ?? config.fixtures;
const workspace = flag('workspace') ?? config.workspace;
const graph = flag('graph') ?? 'demo-analytics';

const metric = flag('metric');
const from = flag('from');
const to = flag('to');
if (!metric || !from || !to) {
  console.error(`usage: attribute --metric <id|name> --from <period> --to <period> [flags]

  --graph <name>        semantic model to use (default demo-analytics, read from <workspace>/build/<graph>)
  --mode auto|drivers|slices
  --drivers a,b         restrict the driver set
  --dimensions a,b      restrict the slice dimensions
  --depth <n>           max depth (default 2)
  --max-queries <n>     query budget (default 40)
  --json                print the whole result instead of the narrative
  --harvest             store the lessons in <workspace>/skills`);
  process.exit(2);
}

const stored = readJson<{ candidates: MergedCandidate[] }>(join(workspace, 'build', graph, 'candidates.json'));
if (!stored) {
  console.error(`no build for '${graph}' in ${workspace}; run: npm run semantic -- build --graph ${graph}`);
  process.exit(2);
}

const dbPath = join(fixtures, 'data', 'demo.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const catalog = readSqliteCatalog(db, dbPath);
  const runner = sqliteRunner(db, { rowLimit: 1000, timeoutMs: 10_000 });
  const run = (sql: string) => {
    assertReadOnly(sql);
    return runner(sql);
  };

  const result = attribute({
    metric,
    from,
    to,
    run,
    index: indexModel(stored.candidates),
    ...(flag('mode') ? { mode: flag('mode') as 'auto' | 'drivers' | 'slices' } : {}),
    ...(flag('drivers') ? { drivers: flag('drivers')!.split(',').map((part) => part.trim()) } : {}),
    ...(flag('dimensions') ? { dimensions: flag('dimensions')!.split(',').map((part) => part.trim()) } : {}),
    ...(flag('depth') ? { maxDepth: Number(flag('depth')) } : {}),
    ...(flag('max-queries') ? { maxQueries: Number(flag('max-queries')) } : {}),
  });

  let harvested: { id: string; status: string }[] = [];
  if (argv.includes('--harvest')) {
    const store = new SkillStore(join(workspace, 'skills'));
    harvested = harvestFromAttribution(store, result, { actor: flag('actor') ?? 'cli' })
      .map((tip) => ({ id: tip.id, status: tip.status }));
  }

  if (json) {
    console.log(JSON.stringify({ ...result, harvested, catalogTables: catalog.tables.length }, null, 2));
  } else {
    console.log(result.explanation);
    console.log('');
    console.log(summarize(result));
    console.log(`queries: ${result.cost.queries} (naive: ${result.cost.naiveQueries}) · iterations: ${result.cost.iterations} · ${result.cost.ms}ms`);
    for (const warning of result.confidence.warnings) console.log(`warning: ${warning}`);
    for (const tip of harvested) console.log(`skill: ${tip.status} ${tip.id}`);
  }
} finally {
  db.close();
}
