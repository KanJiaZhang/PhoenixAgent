/**
 * M2: the semantic agent. Extraction, merge, probes, evaluation, review and publish - in the order the
 * pipeline runs them, because that order is the argument.
 */

export { extractFromDdl } from './extract/ddl.ts';
export { extractFromEtl, splitRatio } from './extract/etlsql.ts';
export { extractFromCatalog, timeGrainExpression } from './extract/catalog.ts';
export { extractFromDocs } from './extract/docs.ts';
export { mergeCandidates, normalizeExpression } from './merge.ts';
export type { MergedCandidate, Conflict, Observation, MergeResult } from './merge.ts';
export { indexModel, renderTotal, renderByDimension, qualifyColumn, tableOfColumnId, RenderError } from './sql.ts';
export type { ModelIndex, RenderedQuery } from './sql.ts';
export { runProbes, relativeError } from './probes.ts';
export { evaluate } from './evaluate.ts';
export { ReviewLog, applyRevisions, setPath, openConflicts, humanCandidate } from './review.ts';
export { publish, buildSchemaDraft } from './publish.ts';
export type { PublishResult } from './publish.ts';
export { build, buildModel, rebuildReport, loadBuild, readSources, nextModelVersion, diffCandidates } from './pipeline.ts';
export { diffModels, driftReport, shadowAsk, releaseGate, modelCounts } from './version.ts';
export type { ModelDiff, Change, Compatibility, DriftReport, DriftIssue, LiveTable, ShadowResult, ModelCounts, ReleaseDecision } from './version.ts';
export { interpret, translate, ask, requestedGrain } from './ask/index.ts';
export type { QuerySpec, Interpretation, SemanticPlan, AskResult, TranslateResult } from './ask/index.ts';
export type { BuildOptions, BuildOutcome, SourceFile, UnreadSource } from './pipeline.ts';
