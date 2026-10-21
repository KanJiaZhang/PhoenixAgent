/**
 * Shared plumbing for the runnable instances: one model, one read-only database session, and artifacts that
 * are written where the next run (or a person) can read them.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson, readJson } from '../packages/core/src/workspace.ts';
import { sqliteRunner } from '../packages/dataplane/src/sqlite.ts';
import { assertReadOnly } from '../packages/dataplane/src/guard.ts';
import { indexModel } from '../packages/semantic/src/sql.ts';
import { build } from '../packages/semantic/src/pipeline.ts';
import { ReviewLog, applyRevisions } from '../packages/semantic/src/review.ts';

export const root = process.cwd();
export const fixtures = join(root, 'fixtures', 'demo');

export function prepareWorkspace(name) {
  const workspace = join(root, '.pag', 'examples', name);
  rmSync(workspace, { recursive: true, force: true });
  return workspace;
}

/** Builds the semantic model into the workspace (idempotent) and returns the reviewed index. */
export function loadModel(workspace, graph, now) {
  const buildPath = join(workspace, 'build', graph, 'candidates.json');
  try {
    readFileSync(buildPath);
  } catch {
    build({ fixtures, graph, workspace, now });
  }
  const stored = JSON.parse(readFileSync(buildPath, 'utf8'));
  const reviewed = applyRevisions(stored.candidates, new ReviewLog(join(workspace, 'reviews', `${graph}.jsonl`)).all());
  return { stored, index: indexModel(reviewed), candidates: reviewed };
}

export function openRun() {
  const db = new DatabaseSync(join(fixtures, 'data', 'demo.db'), { readOnly: true });
  const runner = sqliteRunner(db, { rowLimit: 200_000, timeoutMs: 30_000 });
  return {
    db,
    run: (sql) => {
      assertReadOnly(sql);
      return runner(sql);
    },
    close: () => db.close(),
  };
}

export function writeArtifact(workspace, name, value) {
  const path = join(workspace, 'artifacts', name);
  writeJson(path, value);
  return path;
}

export function readSpec(id) {
  return JSON.parse(readFileSync(join(root, 'agents', `${id}.agent.json`), 'utf8'));
}

/** A tiny assertion toolkit: an example that cannot prove its own claims is a demo, not a test. */
let passes = 0;
const failures = [];
export function expect(name, condition, detail = '') {
  if (condition) {
    passes++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

export function finish(title) {
  console.log(`\n${title}: ${passes} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log(`  failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

export function money(value) {
  if (!Number.isFinite(value)) return String(value);
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absolute >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (absolute >= 1) return value.toFixed(2);
  return value.toFixed(6);
}

export { readJson };
