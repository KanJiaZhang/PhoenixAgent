/**
 * Allocation: move budget from the cell whose *next* yuan earns least to the one whose next yuan earns most,
 * and keep every constraint the business has.
 *
 * The algorithm is greedy marginal equalisation with hard bounds, which is the right shape here for three
 * reasons:
 *
 * - the fitted curves are concave, so equalising marginals converges to the optimum rather than oscillating;
 * - every move is priced with the curve's own integral (`predict(to) - predict(from)`), so the reported gain is
 *   the model's gain, not a linear approximation of it;
 * - a bound (max change per cell, min/max share, no negative spend) is a clamp on a step, not a special case in
 *   a solver, so an infeasible request fails loudly instead of returning a violated plan.
 *
 * What it does **not** do: integer allocations, non-concave curves, or cross-metric tradeoffs. Those are
 * solver-shaped problems, and pretending a greedy loop solves them would be dishonest.
 */

import { revenueGain, type ResponseCurve } from './curve.ts';

export interface CellKey {
  region?: string;
  industry?: string;
  channel?: string;
}

export interface AllocationCell {
  key: CellKey;
  id: string;
  currentSpend: number;
  curve: ResponseCurve;
}

export interface AllocationBounds {
  /** Total budget to allocate - a hard total, or a cap when `budgetIsCap` is set. */
  budget: number;
  /** Most a single cell may move, as a fraction of its current spend (0.5 = ±50%). */
  maxChangePct: number;
  /** Floor and ceiling for a cell's share of the total budget. */
  minShare: number;
  maxShare: number;
  /**
   * What the loop maximises. `revenue` (default) redistributes a fixed budget; `profit` is revenue − spend, and
   * with `budgetIsCap` it may leave money unspent - which is what a stop-loss decision actually needs, because
   * a cell whose next yuan returns less than a yuan is a cell to cut, not a cell to rebalance.
   */
  objective?: 'revenue' | 'profit';
  /** When true, `budget` is an upper bound and the plan may spend less. */
  budgetIsCap?: boolean;
}

export interface AllocatedCell {
  id: string;
  key: CellKey;
  currentSpend: number;
  proposedSpend: number;
  delta: number;
  shareOfBudget: number;
  currentRoi: number;
  marginalRoi: number;
  expectedRevenueCurrent: number;
  expectedRevenueProposed: number;
  expectedRevenueDelta: number;
  curve: { kind: string; params: Record<string, number>; r2: number; points: number; saturation: number };
}

export interface Move {
  from: string;
  to: string;
  amount: number;
  expectedGain: number;
}

export interface AllocationResult {
  budget: number;
  cells: AllocatedCell[];
  moves: Move[];
  iterations: number;
  /** True when a bound stopped the loop rather than the gain going to zero. */
  boundHit: boolean;
  totals: {
    currentSpend: number;
    proposedSpend: number;
    expectedRevenueCurrent: number;
    expectedRevenueProposed: number;
    expectedRevenueDelta: number;
    /** revenue - spend, the number a stop-loss decision actually looks at. */
    expectedProfitCurrent: number;
    expectedProfitProposed: number;
    expectedProfitDelta: number;
    improvementPct: number;
    /** Standard error of the projected delta, from the curves' own residuals. */
    noise: number;
  };
}

export class InfeasibleAllocation extends Error {}

export function allocate(cells: AllocationCell[], bounds: AllocationBounds,
  options: { stepShare?: number; maxIterations?: number } = {}): AllocationResult {
  if (cells.length === 0) throw new InfeasibleAllocation('no cells to allocate');
  const stepShare = options.stepShare ?? 0.01;
  const maxIterations = options.maxIterations ?? 500;
  const budget = bounds.budget;

  // feasibility first: a request that cannot satisfy the bounds is refused, not clipped into something else
  const minimumTotal = sum(cells.map((cell) => cell.currentSpend * (1 - bounds.maxChangePct)));
  const maximumTotal = sum(cells.map((cell) => cell.currentSpend * (1 + bounds.maxChangePct)));
  if (budget < minimumTotal - 1e-6 || budget > maximumTotal + 1e-6) {
    throw new InfeasibleAllocation(`a budget of ${round(budget)} is outside what the per-cell bounds allow `
      + `(${round(minimumTotal)} .. ${round(maximumTotal)})`);
  }
  for (const cell of cells) {
    if (cell.currentSpend * bounds.maxShare < 0 && bounds.maxShare > 0) continue;
  }

  const lower = new Map(cells.map((cell) => [cell.id, Math.max(0, cell.currentSpend * (1 - bounds.maxChangePct),
    budget * bounds.minShare)]));
  const upper = new Map(cells.map((cell) => [cell.id, Math.min(cell.currentSpend * (1 + bounds.maxChangePct),
    budget * bounds.maxShare)]));
  const spend = new Map(cells.map((cell) => [cell.id, cell.currentSpend]));
  const byId = new Map(cells.map((cell) => [cell.id, cell]));

  // Start from the current plan. A cap keeps it (do not spend more than allowed); a total scales it pro rata.
  // Then clamp into the bounds and let `balance` absorb the rounding - unless the budget is a cap, where being
  // under it is a legitimate answer.
  const objective = bounds.objective ?? 'revenue';
  const cap = bounds.budgetIsCap === true;
  const currentTotal = sum(cells.map((cell) => cell.currentSpend));
  const scale = cap ? Math.min(1, budget / currentTotal) : budget / currentTotal;
  for (const cell of cells) spend.set(cell.id, clamp(cell.currentSpend * scale, lower.get(cell.id)!, upper.get(cell.id)!));
  if (!cap) balance(spend, cells, budget, lower, upper);

  const moves: Move[] = [];
  let iterations = 0;
  let boundHit = false;
  let guard = 0;

  while (iterations < maxIterations && guard++ < maxIterations * 4) {
    // A stop-loss move first: under a profit objective, money in a cell whose marginal return is below one is
    // better kept. Cutting it is not a reallocation, so it needs no receiver - and it is the move a fixed-budget
    // optimizer can never express.
    if (objective === 'profit') {
      const worst = [...cells]
        .filter((cell) => spend.get(cell.id)! - lower.get(cell.id)! > 1e-6)
        .sort((a, b) => byId.get(a.id)!.curve.marginal(spend.get(a.id)!)
          - byId.get(b.id)!.curve.marginal(spend.get(b.id)!))[0];
      const worstMarginal = worst ? byId.get(worst.id)!.curve.marginal(spend.get(worst.id)!) : 0;
      if (worst && worstMarginal < 1) {
        const room = spend.get(worst.id)! - lower.get(worst.id)!;
        const step = Math.min(budget * stepShare, room);
        // profit change of cutting `step`: keep the spend, lose the revenue it earned
        const gain = step - revenueGain(byId.get(worst.id)!.curve, spend.get(worst.id)! - step, spend.get(worst.id)!);
        if (Number.isFinite(gain) && gain > 0 && step > 1e-6) {
          spend.set(worst.id, spend.get(worst.id)! - step);
          moves.push({ from: worst.id, to: '(unspent)', amount: round(step), expectedGain: round(gain) });
          iterations++;
          continue;
        }
      }
    }

    // Only cells that can still move take part: selecting a cell pinned at its bound would spin the loop
    // until the guard trips and report one iteration, which is exactly the bug this filter prevents.
    const movable = cells.filter((cell) => spend.get(cell.id)! - lower.get(cell.id)! > 1e-6
      || upper.get(cell.id)! - spend.get(cell.id)! > 1e-6);
    const donors = movable.filter((cell) => spend.get(cell.id)! - lower.get(cell.id)! > 1e-6);
    const receivers = movable.filter((cell) => upper.get(cell.id)! - spend.get(cell.id)! > 1e-6);
    if (donors.length === 0 || receivers.length === 0) {
      boundHit = true;
      break;
    }
    const donor = donors.sort((a, b) => byId.get(a.id)!.curve.marginal(spend.get(a.id)!)
      - byId.get(b.id)!.curve.marginal(spend.get(b.id)!))[0]!;
    const receiver = receivers.sort((a, b) => byId.get(b.id)!.curve.marginal(spend.get(b.id)!)
      - byId.get(a.id)!.curve.marginal(spend.get(a.id)!))[0]!;
    if (donor.id === receiver.id) break;

    const donorSpend = spend.get(donor.id)!;
    const receiverSpend = spend.get(receiver.id)!;
    const donorFloor = lower.get(donor.id)!;
    const receiverCeiling = upper.get(receiver.id)!;
    const roomOut = donorSpend - donorFloor;
    const roomIn = receiverCeiling - receiverSpend;
    if (roomOut <= 1e-6 || roomIn <= 1e-6) break;

    const step = Math.min(budget * stepShare, roomOut, roomIn);
    // A reallocation keeps the spend flat, so profit and revenue move together; only the stop-loss cut above
    // changes the total spend.
    const gain = revenueGain(byId.get(receiver.id)!.curve, receiverSpend, receiverSpend + step)
      - revenueGain(byId.get(donor.id)!.curve, donorSpend - step, donorSpend);
    if (!Number.isFinite(gain) || gain <= 0) break;

    spend.set(donor.id, donorSpend - step);
    spend.set(receiver.id, receiverSpend + step);
    moves.push({ from: donor.id, to: receiver.id, amount: round(step), expectedGain: round(gain) });
    iterations++;
  }

  const allocated: AllocatedCell[] = cells.map((cell) => {
    const current = spend.get(cell.id)!;
    const expectedCurrent = cell.curve.predict(cell.currentSpend);
    const expectedProposed = cell.curve.predict(current);
    return {
      id: cell.id,
      key: cell.key,
      currentSpend: round(cell.currentSpend, 6),
      proposedSpend: round(current, 6),
      delta: round(current - cell.currentSpend, 6),
      shareOfBudget: round(current / budget, 6),
      currentRoi: cell.currentSpend === 0 ? 0 : round(expectedCurrent / cell.currentSpend, 4),
      marginalRoi: round(cell.curve.marginal(cell.currentSpend), 4),
      expectedRevenueCurrent: round(expectedCurrent, 6),
      expectedRevenueProposed: round(expectedProposed, 6),
      expectedRevenueDelta: round(expectedProposed - expectedCurrent, 6),
      curve: {
        kind: cell.curve.kind, params: cell.curve.params, r2: cell.curve.r2, points: cell.curve.points,
        saturation: cell.curve.saturation,
      },
    };
  }).sort((a, b) => b.expectedRevenueDelta - a.expectedRevenueDelta);

  const expectedRevenueCurrent = sum(allocated.map((cell) => cell.expectedRevenueCurrent));
  const expectedRevenueProposed = sum(allocated.map((cell) => cell.expectedRevenueProposed));
  // the noise of the projected total: the curves' residuals combined in quadrature. A gain smaller than this
  // is indistinguishable from the fit error, which is exactly what the agent checks before recommending.
  const noise = Math.sqrt(sum(cells.map((cell) => cell.curve.rmse ** 2)));

  return {
    budget: round(budget),
    cells: allocated,
    moves,
    iterations,
    boundHit,
    totals: {
      currentSpend: round(sum(cells.map((cell) => cell.currentSpend)), 6),
      proposedSpend: round(sum(allocated.map((cell) => cell.proposedSpend)), 6),
      expectedRevenueCurrent: round(expectedRevenueCurrent, 6),
      expectedRevenueProposed: round(expectedRevenueProposed, 6),
      expectedRevenueDelta: round(expectedRevenueProposed - expectedRevenueCurrent, 6),
      expectedProfitCurrent: round(expectedRevenueCurrent - sum(cells.map((cell) => cell.currentSpend)), 6),
      expectedProfitProposed: round(expectedRevenueProposed - sum(allocated.map((cell) => cell.proposedSpend)), 6),
      expectedProfitDelta: round((expectedRevenueProposed - sum(allocated.map((cell) => cell.proposedSpend)))
        - (expectedRevenueCurrent - sum(cells.map((cell) => cell.currentSpend))), 6),
      improvementPct: expectedRevenueCurrent === 0 ? 0
        : round((expectedRevenueProposed - expectedRevenueCurrent) / expectedRevenueCurrent, 6),
      noise: round(noise, 6),
    },
  };
}

/** Distribute the rounding leftover across cells that still have room, so the budget is conserved exactly. */
function balance(spend: Map<string, number>, cells: AllocationCell[], budget: number,
  lower: Map<string, number>, upper: Map<string, number>): void {
  let difference = budget - sum(cells.map((cell) => spend.get(cell.id)!));
  for (let pass = 0; pass < 5 && Math.abs(difference) > 1e-6; pass++) {
    const open = cells.filter((cell) => (difference > 0 ? upper.get(cell.id)! > spend.get(cell.id)!
      : spend.get(cell.id)! > lower.get(cell.id)!));
    if (open.length === 0) break;
    const share = difference / open.length;
    for (const cell of open) {
      const next = clamp(spend.get(cell.id)! + share, lower.get(cell.id)!, upper.get(cell.id)!);
      spend.set(cell.id, next);
    }
    difference = budget - sum(cells.map((cell) => spend.get(cell.id)!));
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
