/**
 * Hybrid asking: the model may propose, but it never decides.
 *
 * The deterministic interpreter in `interpret.ts` is narrow on purpose - a vocabulary, a period grammar, a refusal
 * when a breakdown word meets no dimension. That is what makes it auditable, and it is also why a real user's
 * phrasing ("毛利怎么样", "那按月呢") falls out of it. This module adds the two things a narrow grammar needs, in the
 * only order that keeps the guarantees:
 *
 * ```
 * question ──► [lexicon rewrite] ──► [LLM proposal (optional)] ──► [deterministic validation] ──► [ask]
 *                                            │                            │
 *                                            └── a proposal that fails validation is refused, and the
 *                                                deterministic reader is tried instead - labelled as such
 * ```
 *
 * Three rules hold the design together:
 *
 * 1. **A proposal is not an answer.** It is a `QuerySpec` made of ids from the model, and it goes through the same
 *    `translate` that every other question uses. Anything the translator refuses, is refused here too.
 * 2. **A refusal is never silent.** When the model's proposal fails and the deterministic reader answers, the result
 *    says so (`source.fallback`), because the two paths can disagree about intent.
 * 3. **Learning is a review step, not a side effect.** `learnWord` only accepts a target that exists in the model and
 *    a word that is not already mapped; the entry is appended with its evidence. A future question is rewritten by
 *    the lexicon *before* the model sees it, so a learned word works with the LLM switched off.
 */

import type { AgentRefusal } from '../../../core/src/result.ts';
import type { ModelIndex } from '../sql.ts';
import { interpret, type PeriodGrain, type PeriodSpec, type QuerySpec } from './interpret.ts';
import { ask, translate, type AskResult, type SemanticPlan } from './query.ts';
import type { QueryRunner } from '../../../dataplane/src/sqlite.ts';
import { appendJsonl, readJsonl } from '../../../core/src/workspace.ts';
import { join } from 'node:path';

/** The slice of the LLM gateway this module needs; a fake with the same shape is enough to test it. */
export interface ProposalGateway {
  readonly enabled: boolean;
  readonly model: string;
  completeJson<T>(request: { system: string; user: string; temperature?: number }): Promise<T | null>;
}

/** What the model is allowed to return: ids and words, never SQL. */
export interface Proposal {
  metric?: string;
  dimensions?: string[];
  period?: { from: string; to: string; grain?: PeriodGrain } | { said: string };
  compare?: 'yoy' | 'mom';
  topN?: number;
  descending?: boolean;
}

export interface Repair {
  field: 'metric' | 'dimensions' | 'period' | 'topN' | 'compare';
  from: unknown;
  to: unknown;
  reason: string;
}

export interface HybridAsk {
  question: string;
  /** Which reader produced the spec, and whether a fallback happened. */
  source: { kind: 'deterministic' | 'llm'; model?: string; fallback?: string; rewritten?: string };
  spec: QuerySpec | null;
  plan?: SemanticPlan;
  answer?: AskResult;
  refusals: AgentRefusal[];
  repairs: Repair[];
  notes: string[];
}

export interface LexiconEntry {
  word: string;
  /** `metric/<id>` or `dim/<id>` - always an id that existed when the word was learned. */
  target: string;
  source: 'review' | 'llm';
  model: string;
  at: string;
  evidence: string;
}

const SYSTEM = [
  'You translate a business question into a query specification for a semantic model.',
  'Answer with JSON only. Never write SQL.',
  'Shape: {"metric": "<metric id>", "dimensions": ["<dim id>"], "period": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "grain": "day|week|month|quarter|year"}, "topN": <int>, "compare": "yoy|mom", "descending": true}',
  'Use only the ids listed. Omit a field you are not sure about rather than guessing.',
].join('\n');

/** The prompt is the model's whole view of the world: ids, names, and the fact that ids are what count. */
export function buildPrompt(question: string, index: ModelIndex): { system: string; user: string } {
  const metrics = index.metrics.map((metric) => `${metric.id} (${metric.payload.name})`).join(', ');
  const dimensions = index.dimensions.map((dimension) => `${dimension.id} (${dimension.payload.name})`).join(', ');
  return {
    system: SYSTEM,
    user: `Metrics: ${metrics}\nDimensions: ${dimensions}\nQuestion: ${question}`,
  };
}

/**
 * Turns a proposal into a spec, repairing only what can be repaired mechanically.
 *
 * "The model said `spend` instead of `metric/spend`" is a repair. "The model said `profit` and there is no profit
 * metric" is a refusal, not a guess at what it meant.
 */
export function validateProposal(proposal: Proposal, index: ModelIndex, now = new Date()): {
  spec: QuerySpec | null;
  repairs: Repair[];
  refusals: AgentRefusal[];
} {
  const repairs: Repair[] = [];
  const refusals: AgentRefusal[] = [];

  const metric = resolve(index.metrics, proposal.metric);
  if (!metric) {
    return {
      spec: null, repairs,
      refusals: [{
        code: 'no-such-metric',
        message: proposal.metric
          ? `提议里的指标「${proposal.metric}」不在语义模型里`
          : '提议里没有指标',
        hint: `可用指标：${index.metrics.map((entry) => entry.id).join('、')}`,
        candidates: index.metrics.map((entry) => entry.id),
      }],
    };
  }
  if (metric.id !== proposal.metric) repairs.push({ field: 'metric', from: proposal.metric, to: metric.id, reason: 'resolved by name, not id' });

  const dimensions: string[] = [];
  for (const requested of proposal.dimensions ?? []) {
    const dimension = resolve(index.dimensions, requested);
    if (!dimension) {
      refusals.push({
        code: 'no-such-dimension',
        message: `提议里的维度「${requested}」不在语义模型里`,
        hint: `可用维度：${index.dimensions.map((entry) => entry.id).join('、')}`,
        candidates: index.dimensions.map((entry) => entry.id),
      });
      continue;
    }
    if (dimension.id !== requested) repairs.push({ field: 'dimensions', from: requested, to: dimension.id, reason: 'resolved by name, not id' });
    dimensions.push(dimension.id);
  }

  let topN = proposal.topN;
  if (topN !== undefined && (!Number.isInteger(topN) || topN < 1 || topN > 100)) {
    repairs.push({ field: 'topN', from: topN, to: undefined, reason: 'top-N must be an integer between 1 and 100; dropped rather than clamped' });
    topN = undefined;
  }

  const period = proposal.period ? toPeriod(proposal.period, now, repairs) : undefined;
  if (period === null) {
    repairs.push({ field: 'period', from: proposal.period, to: null, reason: 'period must be YYYY-MM-DD from < to; a period said in words is not accepted from a proposal' });
    return { spec: null, repairs, refusals: [{ code: 'ambiguous', message: '提议里的期间无法解析', hint: '给出 from/to（YYYY-MM-DD）或一个可识别的期间说法' }] };
  }

  const spec: QuerySpec = {
    metric: metric.id,
    dimensions,
    ...(period ? { period } : {}),
    ...(proposal.compare ? { compare: proposal.compare } : {}),
    ...(topN === undefined ? {} : { topN }),
    descending: proposal.descending !== false,
    matched: [metric.payload.name, ...dimensions.map((id) => index.dimensions.find((entry) => entry.id === id)?.payload.name ?? id)],
  };

  // The proposal is validated by the same translator every question goes through: a dimension the metric cannot be
  // sliced by, a period with no matching time dimension, a cross-fact side that cannot be filtered - all refuse here.
  const translated = translate({ spec, index });
  if (!translated.plan) return { spec: null, repairs, refusals: translated.refusals };
  return { spec, repairs, refusals };
}

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function toPeriod(input: NonNullable<Proposal['period']>, now: Date, repairs: Repair[]): PeriodSpec | null {
  void now;
  if (!('from' in input) || !('to' in input)) return null;
  const from = input.from;
  const to = input.to;
  if (!DATE.test(from) || !DATE.test(to) || from >= to) {
    return null;
  }
  const grain = input.grain ?? 'day';
  return { from, to, grain, said: `${from} ~ ${to}` };
}

function resolve<T extends { id: string; payload: { name?: string } }>(entries: T[], requested: string | undefined): T | undefined {
  if (!requested) return undefined;
  const byId = entries.find((entry) => entry.id === requested);
  if (byId) return byId;
  const needle = requested.toLowerCase();
  return entries.find((entry) => (entry.payload.name ?? '').toLowerCase() === needle)
    ?? entries.find((entry) => entry.id.toLowerCase() === needle);
}

// --- the lexicon: learned words are rewrites, applied before anything else -------------------------------

export function lexiconPath(workspace: string, graph: string): string {
  return join(workspace, 'lexicon', `${graph}.jsonl`);
}

export function loadLexicon(workspace: string, graph: string): LexiconEntry[] {
  return readJsonl<LexiconEntry>(lexiconPath(workspace, graph));
}

/**
 * Records a word → id mapping, after checking that the id exists and the word does not already point elsewhere.
 *
 * The two checks are what keep the lexicon from becoming a second, unaudited vocabulary: a word that maps to two
 * metrics is refused at learn time (rather than resolved by "longest match" at ask time), and a target that the
 * model does not have cannot be learned at all.
 */
export function learnWord(options: {
  workspace: string;
  graph: string;
  word: string;
  target: string;
  index: ModelIndex;
  source?: 'review' | 'llm';
  model?: string;
  evidence?: string;
  now?: string;
}): LexiconEntry {
  const word = options.word.trim();
  if (word.length < 2) throw new Error('a learned word needs at least two characters');
  const target = resolve(options.index.metrics, options.target) ?? resolve(options.index.dimensions, options.target);
  if (!target) throw new Error(`cannot learn '${word}' -> '${options.target}': the model has no such metric or dimension`);
  const existing = loadLexicon(options.workspace, options.graph).filter((entry) => entry.word === word);
  if (existing.length > 0 && existing[existing.length - 1]!.target !== target.id) {
    throw new Error(`'${word}' already maps to ${existing[existing.length - 1]!.target}; learning it as ${target.id} would make the same question mean two things`);
  }
  const entry: LexiconEntry = {
    word,
    target: target.id,
    source: options.source ?? 'review',
    model: options.model ?? 'human',
    at: options.now ?? new Date().toISOString(),
    evidence: options.evidence ?? '',
  };
  appendJsonl(lexiconPath(options.workspace, options.graph), entry);
  return entry;
}

/** Rewrites the question by the learned words, before the grammar or the model sees it. */
export function applyLexicon(question: string, lexicon: LexiconEntry[], index: ModelIndex): { question: string; applied: { word: string; target: string }[] } {
  let rewritten = question;
  const applied: { word: string; target: string }[] = [];
  // longest word first: 「投放花费」 before 「花费」
  for (const entry of [...lexicon].sort((left, right) => right.word.length - left.word.length)) {
    if (!rewritten.includes(entry.word)) continue;
    const target = resolve(index.metrics, entry.target) ?? resolve(index.dimensions, entry.target);
    if (!target) continue;
    rewritten = rewritten.split(entry.word).join(target.payload.name ?? entry.target);
    applied.push({ word: entry.word, target: entry.target });
  }
  return { question: rewritten, applied };
}

// --- the ask ----------------------------------------------------------------------------------------------

export interface HybridAskOptions {
  question: string;
  index: ModelIndex;
  run: QueryRunner;
  gateway?: ProposalGateway;
  workspace?: string;
  graph?: string;
  now?: Date;
}

export async function askHybrid(options: HybridAskOptions): Promise<HybridAsk> {
  const now = options.now ?? new Date();
  const lexicon = options.workspace && options.graph ? loadLexicon(options.workspace, options.graph) : [];
  const rewritten = applyLexicon(options.question, lexicon, options.index);
  const notes: string[] = [];
  if (rewritten.applied.length > 0) {
    notes.push(`lexicon rewrote 「${rewritten.applied.map((entry) => entry.word).join('、')}」`);
  }

  const deterministic = interpret(rewritten.question, options.index, now);
  let spec = deterministic.spec;
  let source: HybridAsk['source'] = { kind: 'deterministic' };
  const repairs: Repair[] = [];
  let refusal = deterministic.refusals;

  if (options.gateway?.enabled) {
    const prompt = buildPrompt(rewritten.question, options.index);
    const proposal = await options.gateway.completeJson<Proposal>({ ...prompt, temperature: 0 });
    if (proposal) {
      const validated = validateProposal(proposal, options.index, now);
      repairs.push(...validated.repairs);
      if (validated.spec) {
        spec = validated.spec;
        source = { kind: 'llm', model: options.gateway.model };
        refusal = [];
      } else {
        // the proposal failed the same validation every question passes; say so, then use what we can verify
        refusal = validated.refusals;
        notes.push('the proposal failed validation; falling back to the deterministic reader');
        source = deterministic.spec
          ? { kind: 'deterministic', fallback: 'proposal-refused' }
          : { kind: 'llm', model: options.gateway.model, fallback: 'proposal-refused' };
        if (!deterministic.spec) {
          return { question: options.question, source, spec: null, refusals: refusal, repairs, notes };
        }
      }
    } else {
      notes.push('the model returned no JSON; using the deterministic reader');
    }
  }

  if (rewritten.applied.length > 0) source = { ...source, rewritten: rewritten.question };
  if (!spec) return { question: options.question, source, spec: null, refusals: refusal, repairs, notes };

  const executed = ask({ spec, index: options.index, run: options.run });
  if ('refusals' in executed && !('plan' in executed)) {
    return { question: options.question, source, spec, refusals: executed.refusals, repairs, notes };
  }
  return { question: options.question, source, spec, plan: executed.plan, answer: executed, refusals: [], repairs, notes };
}

// --- multi-turn: a follow-up is a delta, and the delta is itself parsed -------------------------------------

export interface Turn {
  question: string;
  spec: QuerySpec | null;
  answer?: AskResult;
}

/**
 * A conversation where each follow-up only has to say what changed.
 *
 * "那按月呢" has no metric; "换成收入" has no period. Rather than a pronoun model, the session re-parses the follow-up
 * with the previous metric prepended, then fills every field the parse left empty from the previous turn. A follow-up
 * that names neither a metric nor a dimension nor a period is refused instead of being answered as a repeat - a
 * repeated answer is how a conversation hides that it did not understand.
 */
export class AskSession {
  readonly turns: Turn[] = [];
  private readonly options: HybridAskOptions;

  constructor(options: Omit<HybridAskOptions, 'question'>) {
    this.options = { ...options, question: '' };
  }

  get last(): Turn | null {
    return this.turns[this.turns.length - 1] ?? null;
  }

  /**
   * Re-seeds the conversation with a turn from a previous request.
   *
   * A session must not hold a database connection - the connection is per request - so the conversation is rebuilt
   * around the last turn each time. That is also what keeps "the follow-up only changes one thing" honest: the state
   * is a QuerySpec, not a hidden conversation buffer.
   */
  restore(turn: Turn): void {
    this.turns.push(turn);
  }

  async ask(question: string): Promise<HybridAsk> {
    const result = await askHybrid({ ...this.options, question });
    this.turns.push({ question, spec: result.spec, ...(result.answer ? { answer: result.answer } : {}) });
    return result;
  }

  async followUp(question: string): Promise<HybridAsk> {
    const previous = this.last;
    if (!previous?.spec) {
      // nothing to continue from: the follow-up is treated as a fresh question, which is the honest reading
      return this.ask(question);
    }
    const now = this.options.now ?? new Date();
    // Parse the follow-up alone first. "换成收入" names its own metric and must win; "那按月呢" names none, and only
    // then is the previous metric prepended so the grain word has a metric to attach to.
    const alone = interpret(question, this.options.index, now);
    const previousMetric = this.options.index.metrics.find((entry) => entry.id === previous.spec!.metric);
    const parsed = alone.spec ? alone : interpret(`${previousMetric?.payload.name ?? ''} ${question}`, this.options.index, now);
    const spec: QuerySpec = {
      metric: parsed.spec?.metric ?? previous.spec.metric,
      dimensions: parsed.spec?.dimensions.length ? parsed.spec.dimensions : previous.spec.dimensions,
      ...(parsed.spec?.period ?? previous.spec.period ? { period: parsed.spec?.period ?? previous.spec.period! } : {}),
      ...(parsed.spec?.compare ?? previous.spec.compare ? { compare: (parsed.spec?.compare ?? previous.spec.compare)! } : {}),
      ...(parsed.spec?.topN ?? previous.spec.topN ? { topN: (parsed.spec?.topN ?? previous.spec.topN)! } : {}),
      descending: parsed.spec?.descending ?? previous.spec.descending,
      matched: parsed.spec?.matched ?? [],
    };
    const carried = !parsed.spec || (parsed.spec.metric === previous.spec.metric && parsed.spec.dimensions.length === 0);
    const notes = [carried
      ? `carried over: ${spec.metric}${spec.dimensions.length ? ` by ${spec.dimensions.join(',')}` : ''}${spec.period ? ` for ${spec.period.said}` : ''}`
      : 'the follow-up replaced part of the previous question'];
    const executed = ask({ spec, index: this.options.index, run: this.options.run });
    if ('refusals' in executed && !('plan' in executed)) {
      return { question, source: { kind: 'deterministic' }, spec, refusals: executed.refusals, repairs: [], notes };
    }
    this.turns.push({ question, spec, answer: executed });
    return {
      question, source: { kind: 'deterministic' }, spec, plan: executed.plan,
      answer: executed, refusals: [], repairs: [], notes,
    };
  }
}
