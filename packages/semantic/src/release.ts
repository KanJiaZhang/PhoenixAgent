/**
 * A real canary: two revisions, sticky bucketing, and a rollback that is a recorded decision rather than a memory.
 *
 * `shadowAsk` answers "do the numbers move" before a release. This module answers the question after it: **who is
 * getting the new revision, and what would make us stop**. Four properties, each of which is easy to fake and
 * therefore is stated as a check:
 *
 * 1. **Sticky, not random.** A bucket is `hash(actor, question) % 100`, so the same person asking the same question
 *    keeps landing on the same side. A random per-request flip would produce a release that nobody can debug: the
 *    same question would answer differently twice in a row and no one could tell which revision was wrong.
 * 2. **Promotion has evidence.** A canary with no answers is not ready, no matter how long it has been running.
 * 3. **Rollback has a reason.** Manual rollback requires one; automatic rollback writes its own ("3 consecutive
 *    canary errors"), and both land in an append-only event log next to the release.
 * 4. **The failure is visible.** A canary request that throws is recorded and then *re-raised*: silently answering
 *    from the stable revision would hide exactly the defect the canary exists to find.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ReleaseConfig {
  graph: string;
  fromRevision: number;
  toRevision: number;
  /** Share of traffic on `toRevision`, 0-100. */
  canaryPct: number;
  status: 'running' | 'promoted' | 'rolled-back';
  startedAt: string;
  startedBy: string;
  probeQuestion?: string;
  /**
   * Who and what the canary applies to.
   *
   * `groups` is membership (an `x-pagent-group` header). `dimension`/`values` is the answer slice: only a question
   * that explicitly filters that dimension to one of those values is eligible. A question without a filter is *not*
   * the slice - it is everyone, and rolling "everyone" out under the name of 华东 is how a scoped release stops being
   * scoped.
   */
  scope?: { groups?: string[]; dimension?: string; values?: string[] };
  /** When set, a canary answer whose total moves further than this against the stable answer is a failure. */
  qualityGuard?: { maxRelativeDelta: number };
  /** 1 for the first attempt; a retry after a rollback increments it and records why. */
  attempt?: number;
  /** A retry names the rollback it is retrying, so the log cannot show a release that simply reappeared. */
  retry?: { of: string; reason: string; at: string };
  /** While this is in the future, an error on the promoted revision rolls the release back. */
  watchUntil?: string;
  promote?: { at: string; actor: string; answers: number; errors: number; shadow?: string; watchHours?: number };
  rollback?: { at: string; actor: string; reason: string; auto: boolean };
}

export interface ReleaseEvent {
  ts: string;
  graph: string;
  kind: 'start' | 'answer' | 'error' | 'promote' | 'rollback';
  revision: number;
  side: 'canary' | 'stable';
  actor: string;
  question?: string;
  detail?: string;
}

export interface PromoteOptions {
  actor: string;
  now?: string;
  /** A canary needs this many answered requests before it can be promoted. */
  minAnswers?: number;
  /** Error share above which promotion is refused. */
  maxErrorRate?: number;
  /** The shadow verdict for the probe question, when one was run. */
  shadow?: 'promote' | 'hold';
  /** How long the promoted revision stays under the error guard (0 disables it). */
  watchHours?: number;
}

export interface PromoteDecision {
  ok: boolean;
  reasons: string[];
  evidence: { answers: number; errors: number; errorRate: number };
}

const DEFAULTS = { minAnswers: 30, maxErrorRate: 0.02, autoRollbackConsecutiveErrors: 3 };

export class ReleaseStore {
  readonly graph: string;
  readonly configPath: string;
  readonly eventsPath: string;

  constructor(workspace: string, graph: string) {
    this.graph = graph;
    this.configPath = join(workspace, 'release', `${graph}.json`);
    this.eventsPath = join(workspace, 'release', `${graph}.events.jsonl`);
  }

  get(): ReleaseConfig | null {
    if (!existsSync(this.configPath)) return null;
    return JSON.parse(readFileSync(this.configPath, 'utf8')) as ReleaseConfig;
  }

  events(): ReleaseEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ReleaseEvent);
  }

  private write(config: ReleaseConfig): ReleaseConfig {
    mkdirSync(join(this.configPath, '..'), { recursive: true });
    writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return config;
  }

  private log(event: ReleaseEvent): void {
    mkdirSync(join(this.eventsPath, '..'), { recursive: true });
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  start(options: {
    from: number; to: number; canaryPct: number; actor: string; now?: string; probeQuestion?: string;
    scope?: { groups?: string[]; dimension?: string; values?: string[] }; qualityGuard?: { maxRelativeDelta: number };
    /** Required after a rollback: what went wrong last time, and what is different now. */
    retry?: { reason: string };
  }): ReleaseConfig {
    const existing = this.get();
    if (existing?.status === 'running') {
      throw new Error(`a release is already running for '${this.graph}' (v${existing.fromRevision} -> v${existing.toRevision}, ${existing.canaryPct}%)`);
    }
    // after a rollback, restarting is a decision and has to say what changed
    if (existing?.status === 'rolled-back' && !options.retry?.reason?.trim()) {
      throw new Error(`the last release for '${this.graph}' was rolled back (${existing.rollback?.reason ?? 'no reason'}): a retry needs a reason saying what is different`);
    }
    if (options.from === options.to) throw new Error('a release needs two different revisions');
    if (!Number.isFinite(options.canaryPct) || options.canaryPct <= 0 || options.canaryPct > 100) {
      throw new Error('canaryPct must be between 1 and 100');
    }
    const config: ReleaseConfig = {
      graph: this.graph,
      fromRevision: options.from,
      toRevision: options.to,
      canaryPct: Math.round(options.canaryPct),
      status: 'running',
      startedAt: options.now ?? new Date().toISOString(),
      startedBy: options.actor,
      attempt: (existing?.attempt ?? 0) + 1,
      ...(existing?.status === 'rolled-back' && options.retry
        ? { retry: { of: existing.rollback?.reason ?? 'no reason', reason: options.retry.reason, at: options.now ?? new Date().toISOString() } }
        : {}),
      ...(options.probeQuestion ? { probeQuestion: options.probeQuestion } : {}),
      ...(options.scope && (options.scope.groups?.length || options.scope.dimension)
        ? {
          scope: {
            ...(options.scope.groups?.length ? { groups: options.scope.groups } : {}),
            ...(options.scope.dimension ? { dimension: options.scope.dimension, values: options.scope.values ?? [] } : {}),
          },
        }
        : {}),
      ...(options.qualityGuard ? { qualityGuard: options.qualityGuard } : {}),
    };
    this.write(config);
    this.log({ ts: config.startedAt, graph: this.graph, kind: 'start', revision: config.toRevision, side: 'canary', actor: options.actor, detail: `${config.canaryPct}%` });
    return config;
  }

  record(event: Omit<ReleaseEvent, 'graph' | 'ts'> & { ts?: string }): ReleaseEvent {
    const complete: ReleaseEvent = { ...event, graph: this.graph, ts: event.ts ?? new Date().toISOString() };
    this.log(complete);
    return complete;
  }

  /** Answer/error counts for the canary side of the current release. */
  canaryEvidence(): { answers: number; errors: number; errorRate: number; consecutiveErrors: number } {
    const events = this.events();
    // only the traffic of the *current* release counts: a previous canary's answers are not evidence for this one
    const start = events.map((event) => event.kind).lastIndexOf('start');
    const current = start < 0 ? events : events.slice(start);
    const answers = current.filter((event) => event.kind === 'answer' && event.side === 'canary').length;
    const errors = current.filter((event) => event.kind === 'error' && event.side === 'canary').length;
    const all = current.filter((event) => (event.kind === 'answer' || event.kind === 'error') && event.side === 'canary');
    let consecutiveErrors = 0;
    for (let index = all.length - 1; index >= 0; index--) {
      if (all[index]!.kind !== 'error') break;
      consecutiveErrors++;
    }
    return { answers, errors, errorRate: answers + errors === 0 ? 0 : errors / (answers + errors), consecutiveErrors };
  }

  /**
   * Promotion is refused unless the canary has actually served traffic and has not been failing.
   *
   * "It has been running for a day" is not evidence; thirty answered requests and no errors is.
   */
  canPromote(options: PromoteOptions): PromoteDecision {
    const config = this.get();
    if (!config || config.status !== 'running') {
      return { ok: false, reasons: ['there is no running release to promote'], evidence: { answers: 0, errors: 0, errorRate: 0 } };
    }
    const evidence = this.canaryEvidence();
    const reasons: string[] = [];
    const minAnswers = options.minAnswers ?? DEFAULTS.minAnswers;
    const maxErrorRate = options.maxErrorRate ?? DEFAULTS.maxErrorRate;
    if (evidence.answers < minAnswers) {
      reasons.push(`only ${evidence.answers} canary answers; ${minAnswers} are required before promoting on evidence`);
    }
    if (evidence.errorRate > maxErrorRate) {
      reasons.push(`canary error rate ${(evidence.errorRate * 100).toFixed(2)}% exceeds ${(maxErrorRate * 100).toFixed(2)}%`);
    }
    if (options.shadow === 'hold') reasons.push('the shadow comparison for the probe question moved the numbers');
    return { ok: reasons.length === 0, reasons, evidence };
  }

  promote(options: PromoteOptions): ReleaseConfig {
    const decision = this.canPromote(options);
    const config = this.get()!;
    if (!decision.ok) {
      // a refused promotion is not logged as one: the log says what happened, not what was asked for
      this.log({
        ts: options.now ?? new Date().toISOString(), graph: this.graph, kind: 'error',
        revision: config.toRevision, side: 'canary', actor: options.actor,
        detail: `promotion refused: ${decision.reasons.join('; ')}`,
      });
      throw new Error(`promotion refused: ${decision.reasons.join('; ')}`);
    }
    const watchHours = options.watchHours ?? 24;
    const at = options.now ?? new Date().toISOString();
    const promoted: ReleaseConfig = {
      ...config,
      canaryPct: 100,
      status: 'promoted',
      // promotion is not the end of the guard: errors during the watch window still roll it back
      ...(watchHours > 0 ? { watchUntil: new Date(Date.parse(at) + watchHours * 3_600_000).toISOString() } : {}),
      promote: {
        at,
        actor: options.actor,
        answers: decision.evidence.answers,
        errors: decision.evidence.errors,
        watchHours,
        ...(options.shadow ? { shadow: options.shadow } : {}),
      },
    };
    this.write(promoted);
    this.log({ ts: promoted.promote!.at, graph: this.graph, kind: 'promote', revision: config.toRevision, side: 'canary', actor: options.actor });
    return promoted;
  }

  rollback(options: { actor: string; reason: string; auto?: boolean; now?: string }): ReleaseConfig {
    const config = this.get();
    if (!config) throw new Error(`no release for '${this.graph}'`);
    if (options.reason.trim().length === 0) throw new Error('a rollback needs a reason: it is a decision, not an undo');
    const rolled: ReleaseConfig = {
      ...config,
      canaryPct: 0,
      status: 'rolled-back',
      rollback: { at: options.now ?? new Date().toISOString(), actor: options.actor, reason: options.reason, auto: options.auto === true },
    };
    this.write(rolled);
    this.log({ ts: rolled.rollback!.at, graph: this.graph, kind: 'rollback', revision: config.toRevision, side: 'canary', actor: options.actor, detail: options.reason });
    return rolled;
  }

  /** Called after a canary error: three in a row and the release stops by itself, with the reason recorded. */
  /** True while the promoted revision is still being watched. */
  watchActive(now = new Date().toISOString()): boolean {
    const config = this.get();
    if (!config || config.status !== 'promoted' || !config.watchUntil) return false;
    return now < config.watchUntil;
  }

  autoRollbackAfterErrors(options: { actor: string; now?: string; consecutive?: number }): ReleaseConfig | null {
    const config = this.get();
    if (!config) return null;
    const watching = config.status === 'promoted' && config.watchUntil !== undefined
      && (options.now ?? new Date().toISOString()) < config.watchUntil;
    if (config.status !== 'running' && !watching) return null;
    const evidence = this.canaryEvidence();
    const threshold = options.consecutive ?? DEFAULTS.autoRollbackConsecutiveErrors;
    if (evidence.consecutiveErrors < threshold) return null;
    return this.rollback({
      actor: options.actor,
      reason: config.status === 'promoted'
        ? `post-promotion watch: ${evidence.consecutiveErrors} consecutive errors on the new revision`
        : `auto: ${evidence.consecutiveErrors} consecutive canary errors`,
      auto: true,
      ...(options.now ? { now: options.now } : {}),
    });
  }
}

/** Deterministic 0-99 bucket: the same actor asking the same question always lands in the same place. */
export function bucketOf(actor: string, question: string): number {
  let hash = 0x811c9dc5;
  const text = `${actor}|${question.trim().toLowerCase()}`;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/**
 * Which revision this request gets.
 *
 * A promoted release serves the new revision to everyone; a rolled-back one serves nobody; a running one uses the
 * bucket. There is no "random" branch, which is what makes a canary reproducible from the request alone.
 */
export function pickRevision(config: ReleaseConfig | null, actor: string, question: string, group?: string,
  filters?: { dimension: string; value: string }[]): {
  revision: 'stable' | 'canary';
  bucket: number;
  side: 'stable' | 'canary' | 'promoted' | 'rolled-back' | 'none' | 'out-of-scope';
} {
  if (!config) return { revision: 'stable', bucket: -1, side: 'none' };
  const bucket = bucketOf(actor, question);
  if (config.status === 'promoted') return { revision: 'canary', bucket, side: 'promoted' };
  if (config.status === 'rolled-back') return { revision: 'stable', bucket, side: 'rolled-back' };
  // a scoped release excludes everyone outside it before the bucket is even consulted
  if (config.scope?.groups?.length && !(group && config.scope.groups.includes(group))) {
    return { revision: 'stable', bucket, side: 'out-of-scope' };
  }
  if (config.scope?.dimension) {
    const wanted = config.scope.values ?? [];
    const target = config.scope.dimension;
    const bare = target.startsWith('dim/') ? target.slice(4) : target;
    const match = (filters ?? []).some((filter) =>
      (filter.dimension === target || filter.dimension === bare)
      && (wanted.length === 0 || wanted.includes(filter.value)));
    if (!match) return { revision: 'stable', bucket, side: 'out-of-scope' };
  }
  return bucket < config.canaryPct
    ? { revision: 'canary', bucket, side: 'canary' }
    : { revision: 'stable', bucket, side: 'stable' };
}
