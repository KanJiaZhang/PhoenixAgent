/**
 * M7: the risk-strategy agent. Trend, feature effectiveness with a hard point-in-time gate, rule synthesis, an
 * offline backtest with incrementality, and an approval log that a person - not the agent - writes to.
 */

export { riskAgent, RiskApprovals } from './agent.ts';
export type { RiskOptions, RiskResult, Approval } from './agent.ts';
export { analyseTrend, detectChangePoint, detectSpikes, toSeries } from './trend.ts';
export type { TrendReport, PeriodStat, ChangePoint, Spike, TrendOptions } from './trend.ts';
export { evaluateFeature, rankAuc, kolmogorovSmirnov, informationValue, populationStability } from './features.ts';
export type { FeatureReport, FeatureBins, LabelledValue } from './features.ts';
export { synthesizeRules, backtest, incrementOf, matches, parseExpression } from './rules.ts';
export { auditRules } from './audit.ts';
export { buildSnapshot, buildSnapshots, snapshotCutoff, featuresAt, featureValue, GRAPH_FEATURES, publishAndCrossCheck, payloadFromLinks, cleanupPublishedSchema } from './graph.ts';
export type { EntityLink, GraphAccountFeatures, GraphSnapshot, CrossCheck, GraphFeatureName } from './graph.ts';
export { graphFeaturesReport } from './graph-report.ts';
export type { GraphReport, GraphReportOptions } from './graph-report.ts';
export { fitLogistic, fitStandardizer, evaluate } from './model.ts';
export type { Sample, LogisticModel, Standardizer, Evaluation, FitOptions } from './model.ts';
export type { RuleAudit, AuditedRule, AuditOptions } from './audit.ts';
export type { RuleCandidate, RuleMetrics, Incremental, Condition, RiskEvent, SynthesizeOptions } from './rules.ts';
export { analyseRuleSet } from './conflicts.ts';
export type { RuleSpec, RuleStanding, RulePair, RuleSetAnalysis, RuleSetOptions } from './conflicts.ts';
export { capacityPlan, erlangC } from './capacity.ts';
export type { CapacityInput, CapacityPlan } from './capacity.ts';
export { narrate } from './narrate.ts';
