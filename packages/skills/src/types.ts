/**
 * A skill is a *claim with evidence and a scope*, not a paragraph in a prompt.
 *
 * The plan's requirement 7 is "deposit query-performance tuning into a skill module, and add new tips as they
 * appear". The temptation is to append sentences to a system prompt, and that fails in a specific way: the
 * prompt grows, nothing is attributable, a stale tip never dies, and no one can say why the agent did
 * something. So the model here is deliberately boring and auditable:
 *
 * - **Evidence is mandatory.** A tip with no run behind it is refused at harvest time, not filtered out later.
 * - **Scope is a hard filter, not a hint.** A `postgres` tip is never returned for a `mysql` query, and a tip
 *   about `fact_order` is not offered for a query that does not read it. Cross-dialect bleed is a correctness
 *   bug, not a ranking question.
 * - **Status is earned.** `candidate` becomes `adopted` after two *independent* confirmations (distinct run
 *   ids) or a human; two misses retire it. A tip that keeps being wrong does not get to stay.
 * - **The log is append-only.** Every state is a snapshot line, so `history(id)` is the audit trail and
 *   `state` is a replay rather than a mutable row.
 *
 * Two consumers read these: the deterministic injector (a tip whose `applies.rule` matches a finding becomes
 * an actionable suggestion the SQL layer shows) and the narrator (a prompt fragment, never the decision).
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { appendJsonl, ensureDir, listFiles, readJsonl } from '../../core/src/workspace.ts';
import { slug } from '../../contracts/src/index.ts';

export type TipAgent = 'sqllayer' | 'attribution' | 'semantic' | 'campaign' | 'risk';
export type TipKind = 'rewrite' | 'check' | 'avoid' | 'prefer';
export type TipStatus = 'candidate' | 'adopted' | 'deprecated';

export interface TipScope {
  agent: TipAgent;
  /** Empty means "any dialect". A set value is a hard filter. */
  dialect?: string;
  /** The query shape family: `date-prefix`, `projection-star`, `cartesian`, `ratio-slice`, ... */
  shape?: string;
  /** Only offer this tip when the query reads this table. */
  table?: string;
  domain?: string;
}

export interface TipEvidence {
  /** Identifies the run. Two confirmations must come from two different runs. */
  runId: string;
  kind: 'plan' | 'probe' | 'human' | 'review';
  detail: string;
  before?: string;
  after?: string;
  /** Numbers the claim rests on, e.g. `{"rowsMatched":94,"durationBefore":1.2,"durationAfter":0.5}`. */
  metrics?: Record<string, number>;
}

export interface Tip {
  id: string;
  version: number;
  scope: TipScope;
  kind: TipKind;
  /** The actionable sentence a person or a prompt reads. */
  statement: string;
  rationale: string;
  /** How an injector recognises the situation: a rule id from the SQL layer, or keywords in the query. */
  applies: { rule?: string; keywords?: string[] };
  evidence: TipEvidence[];
  /** Run ids that confirmed it; independent runs only, by construction. */
  confirmations: string[];
  misses: number;
  confidence: number;
  status: TipStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: string[];
}

export interface HarvestInput {
  scope: TipScope;
  kind: TipKind;
  statement: string;
  rationale: string;
  applies: { rule?: string; keywords?: string[] };
  evidence: TipEvidence[];
  confidence?: number;
  createdBy?: string;
  now?: string;
}

export interface TipFilter {
  agent?: TipAgent;
  dialect?: string;
  table?: string;
  status?: TipStatus;
  domain?: string;
}

/** Two independent confirmations is the bar; one is an anecdote, three is a habit. */
export const ADOPT_AFTER_CONFIRMATIONS = 2;
/** Two misses retire a tip. It is not "down-weighted forever", it is withdrawn. */
export const RETIRE_AFTER_MISSES = 2;

interface TipLine {
  ts: string;
  action: 'harvest' | 'confirm' | 'miss' | 'promote' | 'demote';
  actor: string;
  note?: string;
  tip: Tip;
}

/**
 * The tips on disk: one append-only JSONL per tip, each line a full snapshot.
 *
 * Snapshot-per-line rather than a diff: the files are small, `history()` is then trivial, and a corrupted
 * line loses one version instead of the audit trail.
 */
export class SkillStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Deterministic id: the same agent, dialect, shape, table and rule is the same tip.
   *
   * The statement text is deliberately **not** part of the id. The same lesson learned from a May query and a
   * December query is one lesson, and if the id included the dates each observation would file a new tip and
   * "confirmed by two independent runs" would never happen. The statement of the first observation is kept;
   * a later one that says it differently is recorded as a note on the confirmation.
   */
  static idFor(scope: TipScope, applies: { rule?: string; keywords?: string[] }, _statement = ''): string {
    const key = [
      scope.agent,
      scope.dialect ?? 'any',
      scope.shape ?? 'any',
      scope.table ?? 'any',
      scope.domain ?? 'any',
      applies.rule ?? (applies.keywords ?? []).map((keyword) => slug(keyword)).join('+'),
    ].join('/');
    return `tip/${key}`;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id.replace(/^tip\//, '').replace(/\//g, '__')}.jsonl`);
  }

  harvest(input: HarvestInput): Tip {
    if (input.evidence.length === 0) {
      throw new Error('a tip without evidence is a guess: harvest needs at least one TipEvidence');
    }
    if (input.statement.trim().length === 0) throw new Error('a tip needs a statement');
    ensureDir(this.dir);
    const id = SkillStore.idFor(input.scope, input.applies, input.statement);
    const existing = this.tryGet(id);
    if (existing) {
      // a second run of the same situation is a confirmation, not a new tip
      const fresh = input.evidence.filter((evidence) => !existing.evidence.some((known) => known.runId === evidence.runId));
      if (fresh.length === 0) return existing;
      return this.confirm(id, fresh[0]!.runId, input.createdBy ?? 'agent', fresh[0]!.detail);
    }

    const ts = input.now ?? new Date().toISOString();
    const tip: Tip = {
      id,
      version: 1,
      scope: input.scope,
      kind: input.kind,
      statement: input.statement,
      rationale: input.rationale,
      applies: input.applies,
      evidence: input.evidence,
      confirmations: [input.evidence[0]!.runId],
      misses: 0,
      confidence: input.confidence ?? 0.7,
      status: 'candidate',
      createdBy: input.createdBy ?? 'agent',
      createdAt: ts,
      updatedAt: ts,
      notes: [],
    };
    this.append(tip, 'harvest', input.createdBy ?? 'agent', 'first observation');
    return tip;
  }

  get(id: string): Tip {
    const history = this.history(id);
    if (history.length === 0) throw new Error(`no tip '${id}' in ${this.dir}`);
    return history[history.length - 1]!;
  }

  tryGet(id: string): Tip | null {
    try {
      return this.get(id);
    } catch {
      return null;
    }
  }

  list(filter: TipFilter = {}): Tip[] {
    return listFiles(this.dir, '.jsonl')
      .map((path) => readJsonl<TipLine>(path).at(-1)?.tip)
      .filter((tip): tip is Tip => tip !== undefined && tip !== null)
      .filter((tip) => !filter.agent || tip.scope.agent === filter.agent)
      .filter((tip) => !filter.dialect || !tip.scope.dialect || tip.scope.dialect === filter.dialect)
      .filter((tip) => !filter.table || !tip.scope.table || tip.scope.table === filter.table)
      .filter((tip) => !filter.status || tip.status === filter.status)
      .filter((tip) => !filter.domain || !tip.scope.domain || tip.scope.domain === filter.domain)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  history(id: string): Tip[] {
    return readJsonl<TipLine>(this.pathFor(id)).map((line) => line.tip);
  }

  /** A confirmation from a run that already confirmed this tip changes nothing. */
  confirm(id: string, runId: string, actor = 'agent', detail = ''): Tip {
    const tip = this.get(id);
    if (tip.confirmations.includes(runId)) return tip;
    const next: Tip = {
      ...tip,
      version: tip.version + 1,
      confirmations: [...tip.confirmations, runId],
      evidence: detail
        ? [...tip.evidence, { runId, kind: 'plan', detail }]
        : tip.evidence,
      updatedAt: new Date().toISOString(),
      notes: tip.notes,
    };
    if (next.status === 'candidate' && next.confirmations.length >= ADOPT_AFTER_CONFIRMATIONS) {
      next.status = 'adopted';
      next.notes = [...next.notes, `adopted after ${next.confirmations.length} independent confirmations`];
      next.confidence = Math.min(0.98, next.confidence + 0.15);
    }
    this.append(next, 'confirm', actor, detail || `confirmed by ${runId}`);
    return next;
  }

  miss(id: string, runId: string, actor = 'agent', note = ''): Tip {
    const tip = this.get(id);
    const next: Tip = {
      ...tip,
      version: tip.version + 1,
      misses: tip.misses + 1,
      updatedAt: new Date().toISOString(),
      notes: note ? [...tip.notes, `miss (${runId}): ${note}`] : tip.notes,
    };
    if (next.misses >= RETIRE_AFTER_MISSES) {
      next.status = 'deprecated';
      next.confidence = Math.max(0.05, next.confidence - 0.4);
      next.notes = [...next.notes, `retired after ${next.misses} misses`];
    }
    this.append(next, 'miss', actor, note);
    return next;
  }

  promote(id: string, actor = 'human', reason = 'confirmed by a person'): Tip {
    const tip = this.get(id);
    const next: Tip = {
      ...tip,
      version: tip.version + 1,
      status: 'adopted',
      confidence: Math.max(tip.confidence, 0.9),
      updatedAt: new Date().toISOString(),
      notes: [...tip.notes, `promoted by ${actor}: ${reason}`],
    };
    this.append(next, 'promote', actor, reason);
    return next;
  }

  demote(id: string, actor = 'human', reason = 'withdrawn'): Tip {
    const tip = this.get(id);
    const next: Tip = {
      ...tip,
      version: tip.version + 1,
      status: 'deprecated',
      updatedAt: new Date().toISOString(),
      notes: [...tip.notes, `demoted by ${actor}: ${reason}`],
    };
    this.append(next, 'demote', actor, reason);
    return next;
  }

  /** confidence × its own hit rate: a tip that is often wrong ranks below one that is never wrong. */
  static score(tip: Tip): number {
    const attempts = tip.confirmations.length + tip.misses;
    const hitRate = attempts === 0 ? 0.5 : tip.confirmations.length / attempts;
    const statusWeight = tip.status === 'adopted' ? 1 : tip.status === 'candidate' ? 0.6 : 0.1;
    return Math.round(tip.confidence * hitRate * statusWeight * 1000) / 1000;
  }

  private append(tip: Tip, action: TipLine['action'], actor: string, note = ''): void {
    const line: TipLine = { ts: tip.updatedAt, action, actor, note, tip };
    appendJsonl(this.pathFor(tip.id), line);
  }
}

/** A stable run id for evidence, so "two independent runs" is checkable rather than claimed. */
export function runId(...parts: string[]): string {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
}
