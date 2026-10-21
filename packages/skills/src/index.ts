/**
 * M4: the skill library. Tips with evidence, a scope that is a filter, a status that is earned, and two
 * consumers - the deterministic injector (`advise`) and the narrator.
 */

export { SkillStore, runId, ADOPT_AFTER_CONFIRMATIONS, RETIRE_AFTER_MISSES } from './types.ts';
export type {
  Tip, TipScope, TipKind, TipStatus, TipAgent, TipEvidence, HarvestInput, TipFilter,
} from './types.ts';
export { advise, ruleSet } from './advise.ts';
export type { Advice, AdviseOptions, AdviceResult } from './advise.ts';
export { harvestFromPlan, harvestFromProbes, harvestFromAttribution, harvestFromCampaign, harvestFromRisk, shapeOf } from './harvest.ts';
export type { HarvestContext } from './harvest.ts';
export { toSkillMarkdown, fromSkillMarkdown } from './export.ts';
export type { SkillExportMeta, ParsedTip } from './export.ts';
export { analysePlanEvidence } from './plan-evidence.ts';
