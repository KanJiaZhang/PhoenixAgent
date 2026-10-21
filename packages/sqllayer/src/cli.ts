#!/usr/bin/env node
/**
 * `sqllayer` on the command line: analyze, rewrite, price, and step through.
 *
 * The CLI exists so the single-step workbench is usable before the console does, and so the verification can
 * exercise the same entry point a person uses. Everything here is a thin wrapper: the rules live in
 * `analyze.ts`, the ledger in `steps.ts`.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { loadConfig } from '../../core/src/config.ts';
import { readSqliteCatalog } from '../../dataplane/src/sqlite.ts';
import { SqlWorkspace } from './steps.ts';
import { analyze, explain, compareEvidence, proposeRewrites } from './analyze.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const many = (name: string): string[] => {
  const value = flag(name);
  return value ? value.split(',').map((part) => part.trim()).filter((part) => part.length > 0) : [];
};
const json = argv.includes('--json');

const config = loadConfig();
const fixtures = flag('fixtures') ?? config.fixtures;
const dbPath = join(fixtures, 'data', 'demo.db');
const workspace = new SqlWorkspace(join(flag('workspace') ?? config.workspace, 'sql'));

function catalog() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return { db, catalog: readSqliteCatalog(db, dbPath) };
  } catch (error) {
    db.close();
    throw error;
  }
}

function print(value: unknown): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

switch (command) {
  case 'plan': {
    const sql = flag('sql');
    if (!sql) throw new Error('plan needs --sql');
    const { db, catalog: meta } = catalog();
    try {
      const result = workspace.plan(sql, {
        catalog: meta,
        dbPath,
        requiredColumns: many('required'),
        actor: flag('actor') ?? 'cli',
      });
      print(result);
    } finally {
      db.close();
    }
    break;
  }
  case 'analyze': {
    const sql = flag('sql');
    if (!sql) throw new Error('analyze needs --sql');
    const { db, catalog: meta } = catalog();
    try {
      print({ findings: analyze(sql, { catalog: meta, requiredColumns: many('required') }) });
    } finally {
      db.close();
    }
    break;
  }
  case 'rewrite': {
    const sql = flag('sql');
    if (!sql) throw new Error('rewrite needs --sql');
    const { db, catalog: meta } = catalog();
    try {
      const steps = proposeRewrites(sql, { catalog: meta, requiredColumns: many('required') });
      const evidence = steps.length === 0 ? null : (() => {
        const before = explain(db, sql);
        const after = explain(db, steps[steps.length - 1]!.sqlAfter);
        return { before, after, comparison: compareEvidence(before, after) };
      })();
      print({ steps, evidence });
    } finally {
      db.close();
    }
    break;
  }
  case 'apply':
  case 'revert': {
    const id = flag('plan');
    const step = Number(flag('step'));
    if (!id || !Number.isFinite(step)) throw new Error(`${command} needs --plan <id> --step <n>`);
    const result = command === 'apply'
      ? workspace.apply(id, step, flag('actor') ?? 'cli')
      : workspace.revert(id, step, flag('actor') ?? 'cli');
    print({ sql: result.sql, state: workspace.state(id) });
    break;
  }
  case 'edit': {
    const id = flag('plan');
    const sql = flag('sql');
    if (!id || !sql) throw new Error('edit needs --plan <id> --sql "..."');
    print(workspace.edit(id, sql, flag('actor') ?? 'cli', flag('note') ?? 'edited by hand'));
    print(workspace.state(id));
    break;
  }
  case 'show': {
    const id = flag('plan');
    if (!id) throw new Error('show needs --plan <id>');
    print(workspace.state(id));
    break;
  }
  default:
    console.log(`usage: sqllayer <plan|analyze|rewrite|apply|revert|edit|show> [flags]

  plan     --sql "..." [--required col1,col2] [--json]   proposals + evidence, recorded in .pag/sql/
  analyze  --sql "..."                                   findings only
  rewrite  --sql "..."                                   steps + before/after plan evidence
  apply    --plan <id> --step <n>                        apply a rewrite (suggestions are refused)
  revert   --plan <id> --step <n>                        take it back
  edit     --plan <id> --sql "..."                       record a human edit in the ledger
  show     --plan <id>                                   replay the ledger`);
}
