/**
 * The design that would falsify the recommendation.
 *
 * A reallocation plan is a projection from fitted curves. It is not evidence, and a plan handed to a business
 * without a way to test it is an opinion with decimals. So every plan carries one: a geoholdout (move the
 * budget in some comparable cells, leave matched cells alone) or a switchback (alternate weeks), plus the two
 * numbers that decide whether it can even be run - the effect the plan predicts and the noise the curves showed.
 *
 * The feasibility arithmetic is deliberately simple and conservative: a two-sample comparison with 80% power at
 * α=0.05 needs about `16σ²/Δ²` observations per arm. If the comparable cells times the horizon cannot supply
 * that, the design says so instead of proposing a test that was never going to detect anything.
 *
 * What this is not: a guarantee, a sample-size calculator for clustered designs, or a substitute for talking to
 * the media team about whether the cells can be split at all. The `note` says that in words.
 */

export interface HoldoutCandidate {
  /** The cell the plan would give more budget to. */
  cell: string;
  region?: string;
  industry?: string;
  channel?: string;
  delta: number;
  expectedRevenueDelta: number;
  /** Residual RMSE of this cell's curve, in revenue units. */
  noise: number;
}

export interface HoldoutDesign {
  design: 'geoholdout' | 'switchback';
  treatment: string;
  control: string;
  horizonWeeks: number;
  effectSize: number;
  noise: number;
  requiredUnitsPerArm: number;
  availableUnits: number;
  feasible: boolean;
  note: string;
}

export function proposeHoldout(input: {
  candidates: HoldoutCandidate[];
  comparableCells: number;
  horizonWeeks?: number;
  alpha?: number;
  power?: number;
  /**
   * The plan's net budget change as a fraction of the current budget. A cut is tested by switching weeks, not by
   * holding out regions - but a rounding-size difference (well under 1%) is not a cut worth redesigning the
   * experiment for, so the threshold is 0.5%.
   */
  netBudgetDeltaRatio?: number;
}): HoldoutDesign {
  const horizonWeeks = input.horizonWeeks ?? 4;
  const top = [...input.candidates].sort((a, b) => b.expectedRevenueDelta - a.expectedRevenueDelta)[0];
  const noise = top?.noise ?? 0;
  const effectSize = top?.expectedRevenueDelta ?? 0;

  // 16 ≈ 2 × (z_{1-α/2} + z_{power})² for α=0.05, power=0.8; kept as a named constant so the approximation is
  // visible rather than magic
  const alpha = input.alpha ?? 0.05;
  const power = input.power ?? 0.8;
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  const requiredUnitsPerArm = effectSize > 0 && noise > 0
    ? Math.ceil((2 * z * z * noise * noise) / (effectSize * effectSize))
    : Number.POSITIVE_INFINITY;
  const availableUnits = Math.max(1, input.comparableCells) * Math.max(1, Math.round(horizonWeeks / 4));
  const feasible = Number.isFinite(requiredUnitsPerArm) && requiredUnitsPerArm <= availableUnits;

  const cutting = (input.netBudgetDeltaRatio ?? 0) < -0.005;
  const control = cutting
    ? '同一批 cell 的对照周（不执行调整的那一半周）'
    : top?.region
      ? `同一大区内未加投的可比 cell（${top.region}）`
      : '同一行业内未加投的可比 cell';

  return {
    // A cut removes spend from an audience that was being reached; holding out regions would confound the loss
    // with regional demand. Alternating weeks across the same cells isolates the change.
    design: cutting ? 'switchback' : 'geoholdout',
    treatment: top
      ? `${top.cell} 的预算按建议调整 ${Math.round(top.delta)} 元`
      : 'no candidate',
    control,
    horizonWeeks,
    effectSize: round(effectSize),
    noise: round(noise),
    requiredUnitsPerArm,
    availableUnits,
    feasible,
    note: feasible
      ? `预计 4 周内可在 ${availableUnits} 个 cell-月 上分辨出 ${round(effectSize)} 的增量；执行前需确认这些 cell 可以按地区/账号拆分`
      : `按当前波动（σ=${round(noise)}）需要 ${requiredUnitsPerArm} 个 cell-月才能分辨 ${round(effectSize)} 的增量，`
        + `可比 cell 只有 ${availableUnits} 个：建议延长观察期或合并相邻地区，否则这个实验测不出效果`,
  };
}

/** Abramowitz-Stegun 26.2.23, plenty accurate for a sample-size approximation. */
function normalQuantile(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
      / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
    / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}
