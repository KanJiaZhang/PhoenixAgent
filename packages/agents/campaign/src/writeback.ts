/**
 * Write-back: turning an approved plan into platform changes, without a second source of truth.
 *
 * Every decision product eventually hits this wall. The agent optimises, the human approves, and then someone
 * copies numbers into an ad platform by hand - which is where the plan and the spend start to disagree. The safe way
 * to automate that step is not a "click to apply" button. It is:
 *
 * 1. **A payload with its own identity.** `idempotencyKey` is a hash of the canonical cells, so the same plan applied
 *    twice is the same request, and a retried request cannot double the budget.
 * 2. **Validation before submission, against the plan** - totals, bounds and the no-cut-that-loses-money rule are
 *    re-checked on the payload, not trusted from the optimiser's memory.
 * 3. **A dry run by default.** `submitWriteback` refuses to commit unless the caller passes `commit: true` *and* the
 *    adapter says the payload is valid; the receipt records what was sent so the platform's state can be reconciled.
 *
 * The adapter is an interface, not an SDK: a platform might be a REST endpoint, a CSV drop, or a person. What does
 * not change is that the receipt comes back and is stored next to the plan.
 */

import { createHash } from 'node:crypto';
import type { AllocationResult } from './optimize.ts';

export interface WritebackCell {
  cell: string;
  region?: string;
  industry?: string;
  channel?: string;
  currentSpend: number;
  proposedSpend: number;
  delta: number;
  deltaPct: number;
  expectedRevenueDelta: number;
  marginalRoi: number;
}

export interface WritebackPlan {
  platform: string;
  objective: 'revenue' | 'profit';
  effectiveFrom: string;
  currency: string;
  budget: number;
  /** Hash over the canonical cells: same plan, same key, regardless of ordering or float formatting. */
  idempotencyKey: string;
  cells: WritebackCell[];
  totals: { currentSpend: number; proposedSpend: number; expectedRevenueDelta: number; expectedProfitDelta: number };
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface ValidationIssue {
  code: 'total-mismatch' | 'bound-violated' | 'over-cap' | 'negative-spend' | 'duplicate-cell' | 'key-mismatch';
  detail: string;
  cell?: string;
}

export interface PlatformAdapter {
  name: string;
  /** The platform's own rules, applied to the payload (not to the plan). */
  validate(payload: WritebackPlan): ValidationIssue[];
  commit(payload: WritebackPlan): Promise<{ receiptId: string; acceptedAt: string }>;
}

export interface WritebackReceipt {
  status: 'dry-run' | 'committed' | 'rejected';
  platform: string;
  idempotencyKey: string;
  sentAt: string;
  cells: number;
  proposedSpend: number;
  issues: ValidationIssue[];
  receiptId?: string;
  acceptedAt?: string;
}

export interface WritebackOptions {
  platform: string;
  effectiveFrom: string;
  /** Defaults to the plan's own bounds; passed in so the check is independent of the optimiser. */
  maxChangePct?: number;
  budget?: number;
  budgetIsCap?: boolean;
  currency?: string;
  now?: string;
}

/** Builds the payload and computes its identity. Pure: no adapter, no network. */
export function buildWriteback(allocation: AllocationResult, options: WritebackOptions): WritebackPlan {
  // Every cell is included, including the ones left untouched: a cell that keeps its budget is part of the
  // total, and dropping it from the payload would make the budget check fail on a perfectly good plan.
  const cells: WritebackCell[] = allocation.cells
    .map((cell) => ({
      cell: cell.id,
      ...(cell.key.region ? { region: cell.key.region } : {}),
      ...(cell.key.industry ? { industry: cell.key.industry } : {}),
      ...(cell.key.channel ? { channel: cell.key.channel } : {}),
      currentSpend: round2(cell.currentSpend),
      proposedSpend: round2(cell.proposedSpend),
      delta: round2(cell.proposedSpend - cell.currentSpend),
      deltaPct: cell.currentSpend === 0 ? 0 : round(cell.delta / cell.currentSpend, 6),
      expectedRevenueDelta: round2(cell.expectedRevenueDelta),
      marginalRoi: round(cell.marginalRoi, 4),
    }))
    .sort((left, right) => left.cell.localeCompare(right.cell));

  // The key is over the cells that will actually be sent: a plan with identical numbers in a different order is the
  // same request, and must carry the same key, or a retry after a timeout would run twice.
  const canonical = JSON.stringify(cells.map((cell) => [cell.cell, cell.proposedSpend]));
  const idempotencyKey = createHash('sha256').update(canonical).digest('hex').slice(0, 32);

  const budget = options.budget ?? allocation.budget;
  const proposedSpend = round2(cells.reduce((total, cell) => total + cell.proposedSpend, 0));
  const maxChangePct = options.maxChangePct ?? 0.5;

  const checks = checkPayload({ cells, budget, budgetIsCap: options.budgetIsCap === true, maxChangePct });

  return {
    platform: options.platform,
    objective: allocation.objective ?? 'revenue',
    effectiveFrom: options.effectiveFrom,
    currency: options.currency ?? 'CNY',
    budget: round2(budget),
    idempotencyKey,
    cells,
    totals: {
      currentSpend: round2(cells.reduce((total, cell) => total + cell.currentSpend, 0)),
      proposedSpend,
      expectedRevenueDelta: round2(cells.reduce((total, cell) => total + cell.expectedRevenueDelta, 0)),
      expectedProfitDelta: round2(allocation.totals.expectedProfitDelta),
    },
    checks,
  };
}

/**
 * The payload's own arithmetic. Called by `buildWriteback` and again by `submitWriteback`: the checks stored on a
 * payload describe the payload that was built, and a value edited after that must not inherit its "ok".
 */
export function checkPayload(input: {
  cells: WritebackCell[];
  budget: number;
  budgetIsCap: boolean;
  maxChangePct: number;
}): WritebackPlan['checks'] {
  const proposedSpend = round2(input.cells.reduce((total, cell) => total + cell.proposedSpend, 0));
  // Rounding each cell to cents accumulates: 36 cells can drift up to 18 fen from the budget. The tolerance is the
  // worst case of that rounding, not one cent, or a perfectly correct plan reads as "budget not conserved".
  const rounding = 0.005 * input.cells.length + 0.01;
  const budgetOk = input.budgetIsCap ? proposedSpend <= round2(input.budget) + rounding : Math.abs(proposedSpend - input.budget) <= rounding;
  const worst = input.cells.reduce((max, cell) => {
    const change = cell.currentSpend === 0 ? (cell.proposedSpend > 0 ? Number.POSITIVE_INFINITY : 0) : Math.abs(cell.proposedSpend / cell.currentSpend - 1);
    return Math.max(max, change);
  }, 0);
  const negative = input.cells.filter((cell) => cell.proposedSpend < 0);
  const duplicate = input.cells.length !== new Set(input.cells.map((cell) => cell.cell)).size;
  return [
    {
      name: input.budgetIsCap ? 'spend within the cap' : 'budget conserved',
      ok: budgetOk,
      detail: `${proposedSpend} vs ${input.budgetIsCap ? `cap ${round2(input.budget)}` : `budget ${round2(input.budget)}`}`,
    },
    { name: 'per-cell move within bounds', ok: worst <= input.maxChangePct + BOUND_EPSILON, detail: `worst ${round(worst, 4)} vs limit ${input.maxChangePct}` },
    { name: 'no negative spend', ok: negative.length === 0, detail: negative.map((cell) => cell.cell).join(', ') || 'none' },
    { name: 'no duplicate cells', ok: !duplicate, detail: duplicate ? 'the same cell appears twice' : 'none' },
  ];
}

/**
 * Re-checks the payload against the plan it came from.
 *
 * The point is that this is a *second* implementation of the constraints: if the optimiser and the payload disagree,
 * the release stops here rather than at the ad platform, where the money is.
 */
export function validateWriteback(payload: WritebackPlan, allocation: AllocationResult, options: Pick<WritebackOptions, 'maxChangePct' | 'budget' | 'budgetIsCap'> = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const budget = options.budget ?? allocation.budget;
  const total = round2(payload.cells.reduce((sum, cell) => sum + cell.proposedSpend, 0));
  const expected = options.budgetIsCap === true ? null : round2(budget);
  const rounding = 0.005 * payload.cells.length + 0.01;
  if (expected !== null && Math.abs(total - expected) > rounding) {
    issues.push({ code: 'total-mismatch', detail: `payload totals ${total}, budget is ${expected} (tolerance ${rounding.toFixed(2)})` });
  }
  if (options.budgetIsCap === true && total > budget + rounding) {
    issues.push({ code: 'over-cap', detail: `payload totals ${total}, cap is ${round2(budget)}` });
  }
  const byId = new Map(allocation.cells.map((cell) => [cell.id, cell]));
  const seen = new Set<string>();
  for (const cell of payload.cells) {
    if (seen.has(cell.cell)) issues.push({ code: 'duplicate-cell', detail: 'the same cell appears twice', cell: cell.cell });
    seen.add(cell.cell);
    const source = byId.get(cell.cell);
    if (!source) {
      issues.push({ code: 'total-mismatch', detail: 'the payload has a cell the plan does not', cell: cell.cell });
      continue;
    }
    if (Math.abs(source.proposedSpend - cell.proposedSpend) > 0.01) {
      issues.push({ code: 'total-mismatch', detail: `payload says ${cell.proposedSpend}, plan says ${round2(source.proposedSpend)}`, cell: cell.cell });
    }
    const limit = options.maxChangePct ?? 0.5;
    if (source.currentSpend > 0 && Math.abs(cell.proposedSpend / source.currentSpend - 1) > limit + BOUND_EPSILON) {
      issues.push({ code: 'bound-violated', detail: `move ${round(cell.proposedSpend / source.currentSpend - 1, 4)} exceeds ${limit}`, cell: cell.cell });
    }
    if (cell.proposedSpend < 0) issues.push({ code: 'negative-spend', detail: 'negative spend', cell: cell.cell });
  }
  const recomputed = buildWriteback(allocation, {
    platform: payload.platform, effectiveFrom: payload.effectiveFrom, budget,
    ...(options.maxChangePct === undefined ? {} : { maxChangePct: options.maxChangePct }),
    ...(options.budgetIsCap === undefined ? {} : { budgetIsCap: options.budgetIsCap }),
  }).idempotencyKey;
  if (recomputed !== payload.idempotencyKey) {
    issues.push({ code: 'key-mismatch', detail: `payload key ${payload.idempotencyKey} does not match the plan's ${recomputed}` });
  }
  return issues;
}

/**
 * Submits the payload - or, by default, pretends to.
 *
 * A dry run still asks the adapter to validate, so the platform's own rules are exercised before anything moves;
 * what it does not do is call `commit`. A rejected payload never reaches the adapter's commit at all.
 */
export async function submitWriteback(payload: WritebackPlan, adapter: PlatformAdapter, options: { commit?: boolean; now?: string } = {}): Promise<WritebackReceipt> {
  const sentAt = options.now ?? new Date().toISOString();
  // Re-derive the payload's arithmetic instead of trusting the checks it shipped with: a number edited between
  // build and submit would otherwise carry the original "ok" all the way to the platform.
  const recheck = checkPayload({
    cells: payload.cells,
    budget: payload.budget,
    budgetIsCap: payload.totals.proposedSpend < payload.budget - 0.01,
    maxChangePct: 1e9,
  });
  const issues = [
    ...recheck.filter((entry) => !entry.ok).map((entry) => ({ code: 'total-mismatch' as const, detail: entry.detail })),
    ...adapter.validate(payload),
  ];
  if (issues.length > 0) {
    return { status: 'rejected', platform: adapter.name, idempotencyKey: payload.idempotencyKey, sentAt, cells: payload.cells.length, proposedSpend: payload.totals.proposedSpend, issues };
  }
  if (options.commit !== true) {
    return { status: 'dry-run', platform: adapter.name, idempotencyKey: payload.idempotencyKey, sentAt, cells: payload.cells.length, proposedSpend: payload.totals.proposedSpend, issues: [] };
  }
  const result = await adapter.commit(payload);
  return {
    status: 'committed', platform: adapter.name, idempotencyKey: payload.idempotencyKey, sentAt,
    cells: payload.cells.length, proposedSpend: payload.totals.proposedSpend, issues: [],
    receiptId: result.receiptId, acceptedAt: result.acceptedAt,
  };
}

/** A platform that only validates: enough to exercise the path without moving money. */
export function dryRunAdapter(name = 'dry-run'): PlatformAdapter {
  return {
    name,
    validate: (payload) => payload.cells.length === 0
      ? [{ code: 'total-mismatch', detail: 'an empty payload is not a plan' }]
      : [],
    commit: async () => { throw new Error('the dry-run adapter does not commit'); },
  };
}

/** Cents-level slack: a cell pinned exactly at the bound must not read as "exceeded" because of float noise. */
const BOUND_EPSILON = 1e-6;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
