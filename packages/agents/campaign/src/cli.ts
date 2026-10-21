#!/usr/bin/env node
/**
 * `campaign` on the command line: fit the curves, allocate the budget, propose the holdout.
 *
 * The narrative is the default because it is what a media team reads; `--json` carries the per-cell curves so
 * the plan can be checked or re-run elsewhere.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readJson } from '../../../core/src/workspace.ts';
import { loadConfig } from '../../../core/src/config.ts';
import { readSqliteCatalog, sqliteRunner } from '../../../dataplane/src/sqlite.ts';
import { assertReadOnly } from '../../../dataplane/src/guard.ts';
import { indexModel } from '../../../semantic/src/sql.ts';
import { SkillStore } from '../../../skills/src/types.ts';
import { harvestFromCampaign } from '../../../skills/src/harvest.ts';
import { campaign } from './agent.ts';
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

const stored = readJson<{ candidates: MergedCandidate[] }>(join(workspace, 'build', graph, 'candidates.json'));
if (!stored) {
  console.error(`no build for '${graph}' in ${workspace}; run: npm run semantic -- build --graph ${graph}`);
  process.exit(2);
}

const dbPath = join(fixtures, 'data', 'demo.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const catalog = readSqliteCatalog(db, dbPath);
  const runner = sqliteRunner(db, { rowLimit: 100_000, timeoutMs: 20_000 });
  const run = (sql: string) => {
    assertReadOnly(sql);
    return runner(sql);
  };

  const result = campaign({
    run,
    index: indexModel(stored.candidates),
    ...(flag('budget') ? { budget: Number(flag('budget')) } : {}),
    ...(flag('max-change') ? { maxChangePct: Number(flag('max-change')) } : {}),
    ...(flag('channel') === 'none' ? { channelDim: '' } : {}),
    ...(flag('horizon-weeks') ? { horizonWeeks: Number(flag('horizon-weeks')) } : {}),
  });

  let harvested: { id: string; status: string }[] = [];
  if (argv.includes('--harvest')) {
    const store = new SkillStore(join(workspace, 'skills'));
    harvested = harvestFromCampaign(store, result, { actor: flag('actor') ?? 'cli' })
      .map((tip) => ({ id: tip.id, status: tip.status }));
  }

  if (json) {
    console.log(JSON.stringify({ ...result, harvested, catalogTables: catalog.tables.length }, null, 2));
  } else {
    console.log(result.explanation);
    console.log('');
    console.log(`queries: ${result.cost.queries} · cells: ${result.cost.cells} · ${result.cost.ms}ms`);
    for (const warning of result.confidence.warnings) console.log(`warning: ${warning}`);
    for (const tip of harvested) console.log(`skill: ${tip.status} ${tip.id}`);
  }
} finally {
  db.close();
}
