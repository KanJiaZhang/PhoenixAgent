/**
 * The single-step workbench: a plan, its steps, and a ledger of what a person did to them.
 *
 * Requirement 5 asks for "single-step verification, with the user able to edit the generated statement". That
 * means three things, and the third is the one usually missing:
 *
 * 1. every step can be looked at on its own (before, after, why, and what the planner said),
 * 2. every step can be applied and taken back,
 * 3. **a person's edit is a step too.** It is recorded with who made it and what it replaced, so a later
 *    reader can tell "the model proposed this" from "an analyst typed it", and so the ledger replays to
 *    exactly the SQL that ran.
 *
 * The ledger is append-only JSONL per plan (plan id = hash of the original SQL), which is what makes the
 * replay an assertion rather than a wish: `state()` recomputes the current SQL from the log, and any drift
 * between that and what was executed would be a bug you can see.
 *
 * The steps are stored in the plan line, not re-derived on read: a plan made with "these are the columns the
 * caller needs" is not reproducible from the SQL alone, and re-deriving it would let a later read apply a
 * different rewrite than the one a person approved.
 */

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { appendJsonl, ensureDir, readJsonl } from '../../core/src/workspace.ts';
import {
  analyze,
  compareEvidence,
  explain,
  proposeRewrites,
  type AnalyzeContext,
  type ExplainEvidence,
  type Finding,
  type RewriteStep,
} from './analyze.ts';

export type LedgerAction = 'plan' | 'apply' | 'revert' | 'edit';

export interface LedgerEntry {
  seq: number;
  ts: string;
  actor: string;
  action: LedgerAction;
  /** For apply/revert: the step's seq. */
  step?: number;
  /** The SQL in effect *after* this entry. */
  sql: string;
  note?: string;
}

export interface PlanRecord {
  id: string;
  original: string;
  createdAt: string;
  findings: Finding[];
  steps: RewriteStep[];
  before?: ExplainEvidence;
}

export interface PlanResult extends PlanRecord {
  after?: ExplainEvidence;
  comparison?: { improved: boolean; changed: string[] };
}

export interface PlanState {
  id: string;
  original: string;
  current: string;
  applied: number[];
  history: LedgerEntry[];
  findings: Finding[];
  steps: RewriteStep[];
}

export interface PlanOptions extends AnalyzeContext {
  dbPath?: string;
  actor?: string;
  now?: string;
}

interface PlanLine {
  seq: 1;
  ts: string;
  actor: string;
  action: 'plan';
  sql: string;
  steps: RewriteStep[];
  findings: Finding[];
  before?: ExplainEvidence;
}

export class SqlWorkspace {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  /** Plans a query: findings, rewrite steps, and the evidence for each side when a database is given. */
  plan(sql: string, options: PlanOptions = {}): PlanResult {
    ensureDir(this.dir);
    const id = createHash('sha1').update(sql).digest('hex').slice(0, 12);
    const steps = proposeRewrites(sql, options);
    const findings = analyze(sql, options);
    const createdAt = options.now ?? new Date().toISOString();

    let before: ExplainEvidence | undefined;
    let after: ExplainEvidence | undefined;
    if (options.dbPath && steps.length > 0) {
      const db = new DatabaseSync(options.dbPath, { readOnly: true });
      try {
        before = explain(db, sql);
        // price the last *rewrite*: a suggestion's SQL is not a candidate for this query
        const lastRewrite = [...steps].reverse().find((step) => step.kind === 'rewrite');
        after = explain(db, (lastRewrite ?? steps[steps.length - 1]!).sqlAfter);
      } finally {
        db.close();
      }
    }

    const line: PlanLine = {
      seq: 1,
      ts: createdAt,
      actor: options.actor ?? 'agent',
      action: 'plan',
      sql,
      steps,
      findings,
      ...(before ? { before } : {}),
    };
    appendJsonl(this.pathFor(id), line);

    return {
      id,
      original: sql,
      createdAt,
      findings,
      steps,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(before && after ? { comparison: compareEvidence(before, after) } : {}),
    };
  }

  /** Replays the ledger: the current SQL, which steps are applied, and the whole history. */
  state(id: string): PlanState {
    const entries = readJsonl<LedgerEntry>(this.pathFor(id));
    if (entries.length === 0) throw new Error(`no plan '${id}' in ${this.dir}`);
    const plan = this.record(id);
    let sql = plan.original;
    const applied: number[] = [];
    for (const entry of entries) {
      if (entry.action === 'apply' && entry.step !== undefined && !applied.includes(entry.step)) applied.push(entry.step);
      if (entry.action === 'revert' && entry.step !== undefined) {
        const index = applied.indexOf(entry.step);
        if (index >= 0) applied.splice(index, 1);
      }
      sql = entry.sql;
    }
    return { id, original: plan.original, current: sql, applied, history: entries, findings: plan.findings, steps: plan.steps };
  }

  /** The plan line, as it was written. */
  record(id: string): PlanRecord {
    const entries = readJsonl<PlanLine>(this.pathFor(id));
    const first = entries[0];
    if (!first) throw new Error(`no plan '${id}'`);
    return {
      id,
      original: first.sql,
      createdAt: first.ts,
      findings: first.findings ?? [],
      steps: first.steps ?? [],
      ...(first.before ? { before: first.before } : {}),
    };
  }

  apply(id: string, step: number, actor = 'human', now = new Date().toISOString()): { sql: string; entry: LedgerEntry } {
    const state = this.state(id);
    const target = state.steps.find((entry) => entry.seq === step);
    if (!target) throw new Error(`plan '${id}' has no step ${step}`);
    if (target.kind !== 'rewrite') {
      throw new Error(`step ${step} is a suggestion, not a rewrite: applying it would change the answer`);
    }
    const entry: LedgerEntry = {
      seq: state.history.length + 1, ts: now, actor, action: 'apply', step, sql: target.sqlAfter,
      note: target.rationale,
    };
    appendJsonl(this.pathFor(id), entry);
    return { sql: entry.sql, entry };
  }

  revert(id: string, step: number, actor = 'human', now = new Date().toISOString()): { sql: string } {
    const state = this.state(id);
    const target = state.steps.find((entry) => entry.seq === step);
    if (!target) throw new Error(`plan '${id}' has no step ${step}`);
    const entry: LedgerEntry = {
      seq: state.history.length + 1, ts: now, actor, action: 'revert', step, sql: target.sqlBefore,
      note: `reverted ${target.rule}`,
    };
    appendJsonl(this.pathFor(id), entry);
    return { sql: entry.sql };
  }

  /** A person's edit is a ledger entry, with the actor and a note, not a silent overwrite. */
  edit(id: string, sql: string, actor = 'human', note = 'edited by hand', now = new Date().toISOString()): { sql: string } {
    const state = this.state(id);
    const entry: LedgerEntry = {
      seq: state.history.length + 1, ts: now, actor, action: 'edit', sql, note,
    };
    appendJsonl(this.pathFor(id), entry);
    return { sql };
  }
}
