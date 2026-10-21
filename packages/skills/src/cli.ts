#!/usr/bin/env node
/**
 * `skills` on the command line: harvest from real runs, inspect, promote, retire, advise, export.
 *
 * The CLI is how a person reviews the skill library. `advise` is the same retrieval the SQL layer uses, so
 * "why did it suggest that" is answerable by running the command a reviewer would run.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readJson } from '../../core/src/workspace.ts';
import { loadConfig } from '../../core/src/config.ts';
import { readSqliteCatalog } from '../../dataplane/src/sqlite.ts';
import { SqlWorkspace } from '../../sqllayer/src/steps.ts';
import { analysePlanEvidence } from './plan-evidence.ts';
import { SkillStore } from './types.ts';
import { advise } from './advise.ts';
import { harvestFromPlan, harvestFromProbes } from './harvest.ts';
import { fromSkillMarkdown, toSkillMarkdown } from './export.ts';
import type { QualityReport } from '../../contracts/src/index.ts';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'list';
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const json = argv.includes('--json');

const config = loadConfig();
const fixtures = flag('fixtures') ?? config.fixtures;
const workspace = flag('workspace') ?? config.workspace;
const store = new SkillStore(join(workspace, 'skills'));
const sqlWorkspace = new SqlWorkspace(join(workspace, 'sql'));

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function catalog() {
  const db = new DatabaseSync(join(fixtures, 'data', 'demo.db'), { readOnly: true });
  try {
    return readSqliteCatalog(db, join(fixtures, 'data', 'demo.db'));
  } finally {
    db.close();
  }
}

switch (command) {
  case 'list': {
    const tips = store.list({
      ...(flag('agent') ? { agent: flag('agent') as never } : {}),
      ...(flag('status') ? { status: flag('status') as never } : {}),
      ...(flag('dialect') ? { dialect: flag('dialect') } : {}),
    });
    print(tips.map((tip) => ({
      id: tip.id, status: tip.status, score: SkillStore.score(tip), scope: tip.scope,
      confirmations: tip.confirmations.length, misses: tip.misses, statement: tip.statement,
    })));
    break;
  }
  case 'advise': {
    const sql = flag('sql');
    if (!sql) throw new Error('advise needs --sql');
    const result = advise(store, sql, {
      ...(flag('dialect') ? { dialect: flag('dialect') } : {}),
      catalog: catalog(),
      limit: Number(flag('limit') ?? 3),
      ...(flag('exclude') ? { exclude: flag('exclude')!.split(',') } : {}),
    });
    print({
      findings: result.findings.map((finding) => finding.rule),
      advice: result.advice.map((entry) => ({ id: entry.tip.id, score: entry.score, why: entry.why, statement: entry.tip.statement })),
      considered: flag('explain') ? result.considered : undefined,
    });
    break;
  }
  case 'confirm':
  case 'miss':
  case 'promote':
  case 'demote': {
    const id = flag('id');
    if (!id) throw new Error(`${command} needs --id`);
    const actor = flag('actor') ?? 'cli';
    if (command === 'confirm') print(store.confirm(id, flag('run') ?? `manual-${Date.now()}`, actor, flag('note') ?? ''));
    if (command === 'miss') print(store.miss(id, flag('run') ?? `manual-${Date.now()}`, actor, flag('note') ?? ''));
    if (command === 'promote') print(store.promote(id, actor, flag('note') ?? 'promoted from the command line'));
    if (command === 'demote') print(store.demote(id, actor, flag('note') ?? 'withdrawn from the command line'));
    break;
  }
  case 'history': {
    const id = flag('id');
    if (!id) throw new Error('history needs --id');
    print(store.history(id).map((tip) => ({ version: tip.version, status: tip.status, confirmations: tip.confirmations.length, misses: tip.misses, notes: tip.notes })));
    break;
  }
  case 'harvest': {
    const reportPath = flag('report');
    const planId = flag('plan');
    const dialect = flag('dialect') ?? 'sqlite';
    if (reportPath) {
      const report = readJson<QualityReport>(reportPath);
      if (!report) throw new Error(`cannot read ${reportPath}`);
      const tips = harvestFromProbes(store, report, { actor: flag('actor') ?? 'cli' });
      print(tips.map((tip) => ({ id: tip.id, status: tip.status, statement: tip.statement })));
      break;
    }
    if (planId) {
      const state = sqlWorkspace.state(planId);
      const evidence = analysePlanEvidence(state, join(fixtures, 'data', 'demo.db'));
      const tips = harvestFromPlan(store, evidence, { dialect, actor: flag('actor') ?? 'cli' });
      print(tips.map((tip) => ({ id: tip.id, status: tip.status, statement: tip.statement })));
      break;
    }
    throw new Error('harvest needs --report <report.json> or --plan <planId>');
  }
  case 'export': {
    const out = flag('out') ?? join(workspace, 'skills', 'SKILL.md');
    const tips = store.list();
    const markdown = toSkillMarkdown(tips, {
      name: 'phoenixagent-skills',
      description: 'Query-performance and semantic-layer tips harvested from real runs, with their evidence.',
      generatedAt: new Date().toISOString(),
    });
    writeFileSync(out, markdown);
    print({ out, tips: tips.length, adopted: tips.filter((tip) => tip.status === 'adopted').length });
    break;
  }
  case 'import': {
    const file = flag('file');
    if (!file) throw new Error('import needs --file SKILL.md');
    const parsed = fromSkillMarkdown(readFileSync(file, 'utf8'));
    print({ meta: parsed.meta, tips: parsed.tips.length });
    break;
  }
  default:
    console.log(`usage: skills <list|advise|confirm|miss|promote|demote|history|harvest|export> [flags]

  list      [--agent sqllayer] [--status adopted] [--dialect sqlite]
  advise    --sql "..." [--dialect sqlite] [--limit 3] [--exclude id] [--explain]
  confirm   --id <tip> [--run <runId>] [--note ...]
  miss      --id <tip> [--run <runId>] [--note ...]
  promote   --id <tip> [--note ...]        demote --id <tip> [--note ...]
  history   --id <tip>
  harvest   --report <report.json> | --plan <planId> [--dialect sqlite]
  export    [--out skills/SKILL.md]`);
}
