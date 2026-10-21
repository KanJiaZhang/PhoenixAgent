/**
 * M2.5: the semantic layer's own query surface - interpret, translate, ask - deterministic over the model.
 *
 * It exists because a semantic layer that cannot answer a question is a document. The interpreter uses the
 * model's vocabulary (never a model in the LLM sense), `translate` renders and checks, `ask` executes and
 * carries the provenance: model revision, metric definition, the SQL that ran, the rows and the limits.
 */

export { interpret, requestedGrain } from './interpret.ts';
export type { QuerySpec, Interpretation, PeriodSpec, PeriodGrain } from './interpret.ts';
export { translate, ask } from './query.ts';
export type { TranslateRequest, TranslateResult, SemanticPlan, AskResult } from './query.ts';

export { askHybrid, validateProposal, buildPrompt, applyLexicon, learnWord, loadLexicon, lexiconPath, AskSession } from './hybrid.ts';
export type { HybridAsk, HybridAskOptions, Proposal, ProposalGateway, Repair, LexiconEntry, Turn } from './hybrid.ts';
export { DraftQueue, proposeFromQuestion } from './drafts.ts';
export type { Draft, ProposeInput } from './drafts.ts';
export { buildValueVocabulary, matchValues, saveVocabulary, loadVocabulary, loadAliases, addAlias, suppressValue, loadSuppressions, valuesPath, aliasPath, suppressionPath, diffVocabulary, refreshVocabulary } from './values.ts';
export type { ValueVocabulary, DimensionValues, ValueAlias, ValueMatch, BuildValuesOptions, ValueSuppression, ValueDiff, RefreshResult } from './values.ts';
export type { ValueContext } from './interpret.ts';
