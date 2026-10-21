/**
 * Feature effectiveness: does this feature separate fraud from not-fraud, is it stable, and is it even legal to
 * use on this event?
 *
 * Four numbers and one hard gate:
 *
 * | number | what it answers |
 * | --- | --- |
 * | AUC | can the feature rank a fraud above a non-fraud? |
 * | KS | how far apart are the two distributions? |
 * | IV | how much information does a binned version carry? |
 * | PSI | did the feature's distribution move between two windows? (a feature can be predictive and stale) |
 * | monotonicity | does the fraud rate rise with the feature? (a non-monotone "top decile" is a red flag) |
 *
 * The gate is **point-in-time**: a feature whose value was computed *after* the event is a future function, and
 * no amount of AUC makes it usable. The check is mechanical - compare the snapshot's `as_of_date` with the
 * event's date - and it is the first thing that runs, because a leaky feature produces the best numbers in the
 * file and the worst rule in production.
 *
 * Everything here is computed from labelled values, not from a model: risk policy needs to be explainable to an
 * auditor, and "the network said so" does not survive one.
 */

export interface LabelledValue {
  value: number;
  label: 0 | 1;
  /** True when the feature's snapshot was computed at or before the event date. */
  asOfBeforeEvent: boolean;
  /** Used for the stability check: which window the event falls in. */
  window: string;
}

export interface FeatureBins {
  lower: number;
  upper: number;
  count: number;
  frauds: number;
  rate: number;
}

export interface FeatureReport {
  name: string;
  usable: boolean;
  /** Blocking: a feature with any reason is not offered to the rule search. */
  reasons: string[];
  /** Not blocking: monotonicity and stability shape *how* the feature may be used, not whether. */
  warnings: string[];
  coverage: number;
  positives: number;
  negatives: number;
  auc: number;
  ks: number;
  iv: number;
  psi: number;
  bins: FeatureBins[];
  monotonicity: 'increasing' | 'decreasing' | 'non-monotonic' | 'flat';
  pointInTime: { ok: boolean; violations: number; checked: number };
}

const BINS = 10;

export function evaluateFeature(name: string, values: LabelledValue[], options: { minPositives?: number } = {}): FeatureReport {
  const minPositives = options.minPositives ?? 20;
  const valid = values.filter((entry) => Number.isFinite(entry.value));
  const violations = values.length - values.filter((entry) => entry.asOfBeforeEvent).length;
  const reasons: string[] = [];
  const warnings: string[] = [];

  const pointInTime = { ok: violations === 0, violations, checked: values.length };
  if (violations > 0) {
    // the hard gate: a future function is not a weak feature, it is an unusable one
    reasons.push(`${violations} of ${values.length} values were computed after the event (as_of_date > event_date): a future function`);
  }

  const positives = valid.filter((entry) => entry.label === 1);
  const negatives = valid.filter((entry) => entry.label === 0);
  const coverage = values.length === 0 ? 0 : valid.length / values.length;
  if (positives.length < minPositives) reasons.push(`only ${positives.length} positives: not enough to evaluate`);
  if (new Set(valid.map((entry) => entry.value)).size <= 1) reasons.push('the feature is constant');

  const bins = quantileBins(valid, BINS);
  const auc = positives.length > 0 && negatives.length > 0 ? rankAuc(positives, negatives) : Number.NaN;
  const ks = positives.length > 0 && negatives.length > 0 ? kolmogorovSmirnov(positives, negatives) : Number.NaN;
  const iv = informationValue(bins);
  const windows = [...new Set(valid.map((entry) => entry.window))].sort();
  const psi = windows.length >= 2 ? populationStability(valid, windows[0]!, windows[windows.length - 1]!) : Number.NaN;
  const monotonicity = monotonicityOf(bins);

  // A feature that is merely non-monotone is still usable - a range condition can capture it - but the rule it
  // produces must be read as "this band is risky", not "more is worse". Only a feature with no separation at all
  // is blocked.
  if (Number.isFinite(auc) && Math.abs(auc - 0.5) < 0.02) reasons.push(`AUC ${round(auc, 4)} is not better than chance`);
  if (monotonicity === 'non-monotonic') warnings.push('the fraud rate is not monotone across bins: read the rule as a band, not a direction');
  if (Number.isFinite(psi) && psi > 0.25) warnings.push(`PSI ${round(psi, 4)}: the feature distribution moved between windows`);

  return {
    name,
    usable: reasons.length === 0,
    reasons,
    warnings,
    coverage: round(coverage, 4),
    positives: positives.length,
    negatives: negatives.length,
    auc: round(auc, 4),
    ks: round(ks, 4),
    iv: round(iv, 4),
    psi: round(psi, 4),
    bins,
    monotonicity,
    pointInTime,
  };
}

/** Rank-based AUC (ties count half), which is the same estimator as the Mann-Whitney U statistic. */
export function rankAuc(positives: LabelledValue[], negatives: LabelledValue[]): number {
  const all = [...positives.map((entry) => ({ value: entry.value, label: 1 })), ...negatives.map((entry) => ({ value: entry.value, label: 0 }))]
    .sort((a, b) => a.value - b.value);
  let rank = 1;
  let index = 0;
  let positiveRankSum = 0;
  while (index < all.length) {
    let end = index;
    while (end + 1 < all.length && all[end + 1]!.value === all[index]!.value) end++;
    const averageRank = (rank + (rank + (end - index))) / 2;
    for (let cursor = index; cursor <= end; cursor++) {
      if (all[cursor]!.label === 1) positiveRankSum += averageRank;
    }
    rank += end - index + 1;
    index = end + 1;
  }
  const n1 = positives.length;
  const n0 = negatives.length;
  return (positiveRankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

/** Max distance between the two empirical CDFs. */
export function kolmogorovSmirnov(positives: LabelledValue[], negatives: LabelledValue[]): number {
  const p = positives.map((entry) => entry.value).sort((a, b) => a - b);
  const n = negatives.map((entry) => entry.value).sort((a, b) => a - b);
  let i = 0;
  let j = 0;
  let maxDistance = 0;
  while (i < p.length && j < n.length) {
    if (p[i]! <= n[j]!) {
      i++;
    } else {
      j++;
    }
    maxDistance = Math.max(maxDistance, Math.abs(i / p.length - j / n.length));
  }
  return maxDistance;
}

/** IV over quantile bins, with the usual 0.5 smoothing so an empty bin does not blow up the log. */
export function informationValue(bins: FeatureBins[]): number {
  const totalFrauds = sum(bins.map((bin) => bin.frauds));
  const totalLegit = sum(bins.map((bin) => bin.count - bin.frauds));
  if (totalFrauds === 0 || totalLegit === 0) return 0;
  let iv = 0;
  for (const bin of bins) {
    const frauds = bin.frauds;
    const legit = bin.count - bin.frauds;
    const shareFraud = (frauds + 0.5) / (totalFrauds + 0.5 * bins.length);
    const shareLegit = (legit + 0.5) / (totalLegit + 0.5 * bins.length);
    iv += (shareFraud - shareLegit) * Math.log(shareFraud / shareLegit);
  }
  return iv;
}

/** Population stability between two windows, on quantile bins of the baseline window. */
export function populationStability(values: LabelledValue[], baselineWindow: string, currentWindow: string): number {
  const baseline = values.filter((entry) => entry.window === baselineWindow).map((entry) => entry.value);
  const current = values.filter((entry) => entry.window === currentWindow).map((entry) => entry.value);
  if (baseline.length === 0 || current.length === 0) return Number.NaN;
  const edges = quantileEdges(baseline, BINS);
  const baselineShare = shareByBin(baseline, edges);
  const currentShare = shareByBin(current, edges);
  let psi = 0;
  for (let index = 0; index < baselineShare.length; index++) {
    const before = Math.max(baselineShare[index]!, 1e-6);
    const after = Math.max(currentShare[index]!, 1e-6);
    psi += (after - before) * Math.log(after / before);
  }
  return psi;
}

function quantileBins(values: LabelledValue[], count: number): FeatureBins[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const size = Math.max(1, Math.floor(sorted.length / count));
  const bins: FeatureBins[] = [];
  for (let index = 0; index < sorted.length; index += size) {
    const slice = sorted.slice(index, index + size);
    if (slice.length === 0) continue;
    const frauds = slice.filter((entry) => entry.label === 1).length;
    bins.push({
      lower: round(slice[0]!.value, 6),
      upper: round(slice[slice.length - 1]!.value, 6),
      count: slice.length,
      frauds,
      rate: round(frauds / slice.length, 6),
    });
  }
  return bins;
}

function quantileEdges(values: number[], count: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let index = 1; index <= count; index++) {
    const position = Math.min(sorted.length - 1, Math.floor((index / count) * (sorted.length - 1)));
    edges.push(sorted[position]!);
  }
  return edges;
}

function shareByBin(values: number[], edges: number[]): number[] {
  const counts = new Array<number>(edges.length).fill(0);
  for (const value of values) {
    let placed = false;
    for (let index = 0; index < edges.length; index++) {
      if (value <= edges[index]!) {
        counts[index]!++;
        placed = true;
        break;
      }
    }
    if (!placed) counts[counts.length - 1]!++;
  }
  const total = values.length || 1;
  return counts.map((count) => count / total);
}

/**
 * Monotonicity as a rank correlation between the bin order and the fraud rate, not as "80% of steps go up".
 *
 * With ten noisy bins and a few hundred positives, one wobble in the top decile makes the step-count test say
 * "non-monotonic" for a feature that is obviously monotone. Spearman's rho is the robust version of the same
 * question, and it degrades gracefully: 0.7 is "increasing enough to read as a direction".
 */
function monotonicityOf(bins: FeatureBins[]): FeatureReport['monotonicity'] {
  const rates = bins.map((bin) => bin.rate).filter((rate) => Number.isFinite(rate));
  if (rates.length < 3) return 'flat';
  if (rates.every((rate) => rate === rates[0])) return 'flat';
  const rho = spearman(rates.map((_, index) => index), rates);
  if (rho >= 0.7) return 'increasing';
  if (rho <= -0.7) return 'decreasing';
  return 'non-monotonic';
}

function spearman(x: number[], y: number[]): number {
  const rank = (values: number[]): number[] => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const ranks = new Array<number>(values.length).fill(0);
    for (let position = 0; position < order.length; position++) ranks[order[position]!.index] = position + 1;
    return ranks;
  };
  const rx = rank(x);
  const ry = rank(y);
  const meanX = rx.reduce((total, value) => total + value, 0) / rx.length;
  const meanY = ry.reduce((total, value) => total + value, 0) / ry.length;
  let numerator = 0;
  let dx = 0;
  let dy = 0;
  for (let index = 0; index < rx.length; index++) {
    numerator += (rx[index]! - meanX) * (ry[index]! - meanY);
    dx += (rx[index]! - meanX) ** 2;
    dy += (ry[index]! - meanY) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : numerator / Math.sqrt(dx * dy);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
