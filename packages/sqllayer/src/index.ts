/**
 * M3: the shared SQL layer. Rules, rewrites, evidence and the step ledger - one place, because every
 * sub-agent runs its SQL through it and the performance knowledge has to accumulate somewhere.
 */

export {
  analyze,
  proposeRewrites,
  datePrefixRewrite,
  explain,
  compareEvidence,
} from './analyze.ts';
export type { Finding, Severity, RewriteStep, ExplainEvidence, AnalyzeContext } from './analyze.ts';
export { SqlWorkspace } from './steps.ts';
export type { LedgerEntry, LedgerAction, PlanRecord, PlanResult, PlanState, PlanOptions } from './steps.ts';
