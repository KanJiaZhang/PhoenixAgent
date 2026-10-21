/**
 * The arithmetic an attribution is allowed to claim.
 *
 * A change can be split exactly in only a few ways, and the model has to say which one applies before a
 * number is reported:
 *
 * - **additive** (a `SUM`/`COUNT` metric over a dimension): each slice's delta adds up to the total delta.
 *   The residual is then a fact about the dimension (uncovered rows, NULLs) and is reported as such.
 * - **ratio** (a metric defined as numerator / denominator, like ROI): the change splits into a numerator
 *   effect and a denominator effect, and the split is *exact*:
 *
 *       r1 - r0 = (n1 - n0)/d1  +  n0*(1/d1 - 1/d0)
 *
 *   The first term is what the numerator did at the new scale; the second is what the denominator's change
 *   was worth at the old numerator. Together they are the whole change, so a residual here means a bug, not
 *   a modelling gap.
 * - **association** (metrics connected by a document's "由 A 与 B 共同决定", with no formula): the drivers'
 *   deltas are reported as *movements that travel together*, and the result says the decomposition is not
 *   claimed. This is the case where a careless agent says "A caused 40% of the change".
 *
 * Nothing here uses a statistical test. With a handful of periods there is no honest way to compute
 * significance, so what the loop reports is a *reporting threshold* (`belowThreshold`), and the narrative says
 * so instead of implying a p-value.
 */

export interface RatioEffects {
  numeratorEffect: number;
  denominatorEffect: number;
  total: number;
  residual: number;
}

/** The exact two-factor split of a ratio's change. */
export function decomposeRatio(input: {
  numeratorPrevious: number;
  numeratorCurrent: number;
  denominatorPrevious: number;
  denominatorCurrent: number;
}): RatioEffects {
  const { numeratorPrevious: n0, numeratorCurrent: n1, denominatorPrevious: d0, denominatorCurrent: d1 } = input;
  if (d0 === 0 || d1 === 0) {
    return { numeratorEffect: Number.NaN, denominatorEffect: Number.NaN, total: Number.NaN, residual: Number.NaN };
  }
  const total = n1 / d1 - n0 / d0;
  const numeratorEffect = (n1 - n0) / d1;
  const denominatorEffect = n0 * (1 / d1 - 1 / d0);
  return {
    numeratorEffect,
    denominatorEffect,
    total,
    residual: total - (numeratorEffect + denominatorEffect),
  };
}

/** Sum of the parts, and what is left over. The caller decides whether a residual is a fact or a bug. */
export function additiveResidual(totalDelta: number, contributions: number[]): {
  explained: number;
  residual: number;
  share: number;
} {
  const explained = contributions.reduce((sum, value) => sum + value, 0);
  const residual = totalDelta - explained;
  return {
    explained,
    residual,
    share: totalDelta === 0 ? (Math.abs(residual) < 1e-9 ? 0 : Number.POSITIVE_INFINITY) : residual / totalDelta,
  };
}

/** Rounding for display only; the comparisons in the loop use the raw numbers. */
export function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
