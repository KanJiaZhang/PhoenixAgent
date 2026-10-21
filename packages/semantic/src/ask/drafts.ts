/**
 * Where new vocabulary comes from: a queue, not a side effect.
 *
 * `learnWord` writes the lexicon, and the lexicon is applied *before* anything parses a question - which makes it the
 * one place where a wrong entry makes every future question quietly wrong. Letting a model call `learnWord` directly
 * would be the agent editing its own vocabulary: the failure is silent, permanent, and invisible in the answer.
 *
 * So proposals go to a draft queue. A draft is not a word yet:
 *
 * | step | who | what is checked |
 * | --- | --- | --- |
 * | propose | analyst, or a model with an analyst's key | the target id must exist, the word must be ≥2 chars and appear in the question |
 * | review | **a different** analyst | accept runs the same `learnWord` guards (no re-pointing, no missing targets) |
 * | reject | the same reviewer | a reason is recorded; the lexicon is untouched |
 *
 * The "different analyst" rule is the same idea as the two signatures on a risk rule: the person who thought of the
 * word is not the person who certifies it. A model may propose with the key it was given; it can never certify.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelIndex } from '../sql.ts';
import { learnWord, loadLexicon, type LexiconEntry, type ProposalGateway } from './hybrid.ts';

export interface Draft {
  id: string;
  word: string;
  /** `metric/<id>` or `dim/<id>`. */
  target: string;
  /** The question the word came from: the evidence a reviewer reads. */
  question: string;
  source: 'llm' | 'manual';
  model: string;
  proposedBy: string;
  at: string;
  status: 'pending' | 'accepted' | 'rejected';
  reviewed?: { by: string; at: string; action: 'accept' | 'reject'; reason?: string };
}

export interface ProposeInput {
  word: string;
  target: string;
  question: string;
  index: ModelIndex;
  source?: 'llm' | 'manual';
  model?: string;
  proposedBy: string;
  now?: string;
}

export class DraftQueue {
  readonly path: string;
  private readonly workspace: string;
  private readonly graph: string;

  constructor(workspace: string, graph: string) {
    this.workspace = workspace;
    this.graph = graph;
    this.path = join(workspace, 'lexicon', `${graph}.drafts.json`);
  }

  all(): Draft[] {
    if (!existsSync(this.path)) return [];
    return JSON.parse(readFileSync(this.path, 'utf8')) as Draft[];
  }

  pending(): Draft[] {
    return this.all().filter((draft) => draft.status === 'pending');
  }

  private save(drafts: Draft[]): void {
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(drafts, null, 2)}\n`, 'utf8');
  }

  propose(input: ProposeInput): Draft {
    const word = input.word.trim();
    if (word.length < 2) throw new Error('a draft needs a word of at least two characters');
    const question = input.question.trim();
    if (question.length === 0) throw new Error('a draft needs the question it came from: that is the evidence');
    // the model may not invent a word that the user never said
    if (!question.includes(word)) throw new Error(`'${word}' does not appear in the question: a proposal must quote the user`);
    const target = this.targetOf(input.target, input.index);
    if (!target) throw new Error(`the model has no '${input.target}': a draft may not point at something that does not exist`);
    const learned = loadLexicon(this.workspace, this.graph).filter((entry) => entry.word === word);
    if (learned.length > 0 && learned[learned.length - 1]!.target !== target) {
      throw new Error(`'${word}' is already learned as ${learned[learned.length - 1]!.target}: re-pointing a word needs a different decision, not a draft`);
    }
    if (this.pending().some((draft) => draft.word === word)) {
      throw new Error(`'${word}' already has a pending draft`);
    }
    const draft: Draft = {
      id: `draft-${Date.now().toString(36)}-${this.all().length + 1}`,
      word,
      target,
      question,
      source: input.source ?? 'manual',
      model: input.model ?? 'human',
      proposedBy: input.proposedBy,
      at: input.now ?? new Date().toISOString(),
      status: 'pending',
    };
    this.save([...this.all(), draft]);
    return draft;
  }

  /** Accepting is the only path from a draft into the lexicon, and it re-runs every guard. */
  decide(id: string, options: { action: 'accept' | 'reject'; actor: string; reason?: string; index: ModelIndex; now?: string }): {
    draft: Draft;
    entry?: LexiconEntry;
  } {
    const drafts = this.all();
    const draft = drafts.find((entry) => entry.id === id);
    if (!draft) throw new Error(`no draft '${id}'`);
    if (draft.status !== 'pending') throw new Error(`draft '${id}' is already ${draft.status}`);
    if (options.actor === draft.proposedBy) {
      throw new Error(`${options.actor} proposed '${draft.word}': the proposer cannot certify their own word`);
    }
    const reviewed = {
      by: options.actor,
      at: options.now ?? new Date().toISOString(),
      action: options.action,
      ...(options.reason ? { reason: options.reason } : {}),
    };
    if (options.action === 'reject') {
      const rejected: Draft = { ...draft, status: 'rejected', reviewed };
      this.save(drafts.map((entry) => (entry.id === id ? rejected : entry)));
      return { draft: rejected };
    }
    // the lexicon write happens here, through the same guard every other caller uses
    const entry = learnWord({
      workspace: this.workspace, graph: this.graph, word: draft.word, target: draft.target, index: options.index,
      source: 'review', model: options.actor, evidence: `${draft.question} (${draft.proposedBy}, ${draft.source})`,
      ...(options.now ? { now: options.now } : {}),
    });
    const accepted: Draft = { ...draft, status: 'accepted', reviewed };
    this.save(drafts.map((item) => (item.id === id ? accepted : item)));
    return { draft: accepted, entry };
  }

  private targetOf(requested: string, index: ModelIndex): string | null {
    const metric = index.metrics.find((entry) => entry.id === requested || entry.payload.name === requested);
    if (metric) return metric.id;
    const dimension = index.dimensions.find((entry) => entry.id === requested || entry.payload.name === requested);
    return dimension ? dimension.id : null;
  }
}

const SYSTEM = [
  'You map words from a business question to ids in a semantic model.',
  'Return JSON only: an array of {"word": "<the exact substring the user wrote>", "target": "<metric/id or dim/id>"}.',
  'Only include words that are NOT already in the model vocabulary. Never invent a word the user did not write.',
  'An empty array is a valid answer.',
].join('\n');

/**
 * Asks the model which words in the question are unknown and what they should map to.
 *
 * Every candidate is then filtered mechanically: the word must appear in the question, the target must exist, and the
 * word must not already be learned or pending. What survives is still only a *draft*.
 */
export async function proposeFromQuestion(options: {
  question: string;
  index: ModelIndex;
  gateway: ProposalGateway;
  actor: string;
  workspace: string;
  graph: string;
  now?: string;
}): Promise<{ drafts: Draft[]; dropped: { word: string; target?: string; reason: string }[] }> {
  if (!options.gateway.enabled) {
    throw new Error('the LLM gateway is disabled: propose a word explicitly, or review questions by hand');
  }
  const vocabulary = options.index.metrics.map((metric) => metric.payload.name).join(', ');
  const proposals = await options.gateway.completeJson<{ word?: string; target?: string }[]>({
    system: SYSTEM,
    user: `Vocabulary: ${vocabulary}\nDimensions: ${options.index.dimensions.map((dimension) => dimension.payload.name).join(', ')}\nQuestion: ${options.question}`,
    temperature: 0,
  });
  const queue = new DraftQueue(options.workspace, options.graph);
  const drafts: Draft[] = [];
  const dropped: { word: string; target?: string; reason: string }[] = [];
  for (const proposal of proposals ?? []) {
    const word = typeof proposal.word === 'string' ? proposal.word.trim() : '';
    const target = typeof proposal.target === 'string' ? proposal.target.trim() : '';
    if (!word || !target) {
      dropped.push({ word, target, reason: 'the proposal was missing a word or a target' });
      continue;
    }
    try {
      drafts.push(queue.propose({
        word, target, question: options.question, index: options.index,
        source: 'llm', model: options.gateway.model, proposedBy: options.actor,
        ...(options.now ? { now: options.now } : {}),
      }));
    } catch (error) {
      dropped.push({ word, target, reason: (error as Error).message });
    }
  }
  return { drafts, dropped };
}
