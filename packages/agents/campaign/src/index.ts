/**
 * M6: the campaign agent. Response curves for the marginal return, a bounded greedy allocation, a holdout
 * design, and a narrative that labels projections as projections.
 */

export { campaign } from './agent.ts';
export type { CampaignOptions, CampaignResult, CampaignCell } from './agent.ts';
export { fitResponse, revenueGain } from './curve.ts';
export type { ResponseCurve, SpendRevenuePoint, CurveKind } from './curve.ts';
export { allocate, InfeasibleAllocation } from './optimize.ts';
export type { AllocationResult, AllocatedCell, AllocationBounds, AllocationCell, Move, CellKey } from './optimize.ts';
export { proposeHoldout } from './holdout.ts';
export type { HoldoutDesign, HoldoutCandidate } from './holdout.ts';
export { narrate } from './narrate.ts';
export { buildWriteback, validateWriteback, submitWriteback, dryRunAdapter, checkPayload } from './writeback.ts';
export { IdempotencyStore, payloadHashOf } from './idempotency.ts';
export type { IdempotencyRecord, ReplayDecision } from './idempotency.ts';
export type { WritebackPlan, WritebackCell, WritebackReceipt, PlatformAdapter, ValidationIssue, WritebackOptions } from './writeback.ts';
