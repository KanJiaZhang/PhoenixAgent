/**
 * M5: the attribution agent. A budgeted loop over the semantic model, with exact decompositions where the
 * model supports one, explicit residuals where it does not, and a narrative that never claims causality.
 */

export { attribute } from './loop.ts';
export type {
  AttributeOptions, AttributionResult, AttributionNode, DriverContribution, SliceContribution, SliceSet,
} from './loop.ts';
export { decomposeRatio, additiveResidual, round } from './decompose.ts';
export type { RatioEffects } from './decompose.ts';
export { narrate, summarize } from './narrate.ts';
