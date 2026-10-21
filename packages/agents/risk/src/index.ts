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
export type { RuleAudit, AuditedRule, AuditOptions } from './audit.ts';
export type { RuleCandidate, RuleMetrics, Incremental, Condition, RiskEvent, SynthesizeOptions } from './rules.ts';
export { narrate } from './narrate.ts';
