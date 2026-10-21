/**
 * Files, and the two guarantees this product needs from them.
 *
 * **Append-only logs.** Review decisions, audit lines and probe runs are written as JSONL and never
 * rewritten. That is what makes "this number came from revision 7 of the model" true rather than decorative:
 * replaying the log reproduces the state, and a later decision cannot silently change what an earlier answer
 * rested on.
 *
 * **Explicit timestamps.** Nothing here calls `new Date()` on its own. The pipeline passes a clock value in,
 * so a build can be replayed and compared byte-for-byte - which is what `verify:m2` asserts when it runs the
 * same fixtures twice and demands the same report.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function appendJsonl(path: string, record: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export function listFiles(root: string, extension?: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!extension || entry.name.toLowerCase().endsWith(extension)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

/** One JSONL file per workspace, one line per action that changed or read something worth explaining. */
export class AuditLog {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  append(entry: AuditEntry): void {
    appendJsonl(this.path, entry);
  }

  recent(limit = 20): AuditEntry[] {
    return readJsonl<AuditEntry>(this.path).slice(-limit);
  }
}
