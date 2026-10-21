/**
 * Trend detection: when did the fraud rate move, how big was the move, and is it distinguishable from noise?
 *
 * Two questions a risk team actually asks, handled separately:
 *
 * - **"Did something change?"** - a split test: for every candidate period, compare the rate before and after
 *   with a two-proportion z. The strongest split is the change point. This is what finds an injected step.
 * - **"Is this month odd?"** - a rolling baseline: compare each period against the previous few, with the
 *   binomial standard error of *that* baseline rate. This is what finds a spike inside a stable regime.
 *
 * Both are deliberately simple and explainable, because a change point nobody can check is worth nothing. Every
 * result carries the two proportions, the sample sizes and the z, so "why was this flagged" is arithmetic.
 *
 * The thresholds (`minZ`, `minLift`, `minSegment`) are *detector settings*, not significance tests: with a
 * dozen periods there is no honest p-value, and the report says so.
 */

export interface PeriodStat {
  period: string;
  events: number;
  frauds: number;
  rate: number;
}

export interface ChangePoint {
  period: string;
  before: { periods: number; events: number; frauds: number; rate: number };
  after: { periods: number; events: number; frauds: number; rate: number };
  z: number;
  lift: number;
  direction: 'up' | 'down';
}

export interface Spike {
  period: string;
  events: number;
  frauds: number;
  rate: number;
  baseline: number;
  z: number;
}

export interface TrendReport {
  dimension: string;
  value: string;
  series: PeriodStat[];
  changePoint: ChangePoint | null;
  spikes: Spike[];
  note: string;
}

export interface TrendOptions {
  /** Smallest segment (in periods) a split may produce. */
  minSegment?: number;
  /** A change point needs |z| at or above this. */
  minZ?: number;
  /** ... and a rate ratio at least this large, so a "significant" 2.1% vs 1.9% is not reported as a change. */
  minLift?: number;
  /** Rolling baseline length for the spike test. */
  baselinePeriods?: number;
}

const DEFAULTS = { minSegment: 4, minZ: 3, minLift: 1.4, baselinePeriods: 6 };

export function toSeries(rows: { period: string; events: number; frauds: number }[]): PeriodStat[] {
  return rows
    .map((row) => ({
      period: row.period,
      events: row.events,
      frauds: row.frauds,
      rate: row.events === 0 ? 0 : row.frauds / row.events,
    }))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}

export function detectChangePoint(series: PeriodStat[], options: TrendOptions = {}): ChangePoint | null {
  const settings = { ...DEFAULTS, ...options };
  const n = series.length;
  if (n < settings.minSegment * 2) return null;

  let best: ChangePoint | null = null;
  for (let split = settings.minSegment; split <= n - settings.minSegment; split++) {
    const before = series.slice(0, split);
    const after = series.slice(split);
    const comparison = compareSegments(before, after);
    if (!comparison) continue;
    const lift = comparison.after.rate / Math.max(comparison.before.rate, 1e-9);
    if (Math.abs(comparison.z) < settings.minZ) continue;
    // a "change" that triples a 0.2% rate is noise with a story; require a real lift
    const passed = lift >= settings.minLift || (comparison.before.rate > 0 && lift <= 1 / settings.minLift);
    if (!passed) continue;
    if (!best || Math.abs(comparison.z) > Math.abs(best.z)) best = comparison;
  }
  return best;
}

export function detectSpikes(series: PeriodStat[], options: TrendOptions = {}): Spike[] {
  const settings = { ...DEFAULTS, ...options };
  const spikes: Spike[] = [];
  for (let index = settings.baselinePeriods; index < series.length; index++) {
    const current = series[index]!;
    const baselineWindow = series.slice(index - settings.baselinePeriods, index);
    const events = baselineWindow.reduce((total, period) => total + period.events, 0);
    const frauds = baselineWindow.reduce((total, period) => total + period.frauds, 0);
    if (events === 0) continue;
    const baseline = frauds / events;
    const spread = Math.sqrt(Math.max(baseline * (1 - baseline), 1e-12) / Math.max(current.events, 1));
    const z = spread === 0 ? 0 : (current.rate - baseline) / spread;
    if (z >= settings.minZ) {
      spikes.push({ period: current.period, events: current.events, frauds: current.frauds, rate: current.rate, baseline, z: round(z) });
    }
  }
  return spikes;
}

export function analyseTrend(dimension: string, value: string, rows: { period: string; events: number; frauds: number }[],
  options: TrendOptions = {}): TrendReport {
  const series = toSeries(rows);
  const changePoint = detectChangePoint(series, options);
  const spikes = detectSpikes(series, options);
  return {
    dimension,
    value,
    series,
    changePoint,
    spikes,
    note: series.length < (options.minSegment ?? DEFAULTS.minSegment) * 2
      ? `only ${series.length} periods: a change point needs at least ${(options.minSegment ?? DEFAULTS.minSegment) * 2}`
      : changePoint
        ? `change detected at ${changePoint.period}: ${(changePoint.before.rate * 100).toFixed(2)}% -> ${(changePoint.after.rate * 100).toFixed(2)}% (z=${changePoint.z})`
        : 'no change point clears the detector settings',
  };
}

function compareSegments(before: PeriodStat[], after: PeriodStat[]): ChangePoint | null {
  const beforeEvents = sum(before.map((period) => period.events));
  const afterEvents = sum(after.map((period) => period.events));
  const beforeFrauds = sum(before.map((period) => period.frauds));
  const afterFrauds = sum(after.map((period) => period.frauds));
  if (beforeEvents === 0 || afterEvents === 0) return null;
  const p1 = beforeFrauds / beforeEvents;
  const p2 = afterFrauds / afterEvents;
  const pooled = (beforeFrauds + afterFrauds) / (beforeEvents + afterEvents);
  const standardError = Math.sqrt(Math.max(pooled * (1 - pooled), 1e-12) * (1 / beforeEvents + 1 / afterEvents));
  const z = standardError === 0 ? 0 : (p2 - p1) / standardError;
  return {
    period: after[0]!.period,
    before: { periods: before.length, events: beforeEvents, frauds: beforeFrauds, rate: round(p1, 6) },
    after: { periods: after.length, events: afterEvents, frauds: afterFrauds, rate: round(p2, 6) },
    z: round(z),
    lift: round(p1 === 0 ? Number.POSITIVE_INFINITY : p2 / p1, 4),
    direction: p2 >= p1 ? 'up' : 'down',
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
