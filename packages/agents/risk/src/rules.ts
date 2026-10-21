/**
 * Rule synthesis and offline backtest: turn effective features into a rule, then measure it the way risk does.
 *
 * The unit of a risk rule is a **conjunction of at most three conditions**, because a policy an analyst cannot
 * read is a policy nobody can defend. For each usable feature the search walks its quantiles in the direction
 * the AUC points, scores every single-condition rule by F0.5 (precision matters more than recall in fraud - a
 * false positive blocks a customer), keeps the best one per feature, and then tries pairs and one triple.
 *
 * Three things make the output reviewable rather than authoritative:
 *
 * - **Every rule is evaluated on a holdout window** the search never saw. A rule that only works in-sample is
 *   reported as such.
 * - **Every rule is compared with the rules already live**: how many cases it catches alone, how many overlap,
 *   how much *incremental* recall it adds. "New rule, +3% recall over the current stack" is a decision;
 *   "AUC 0.8" is not.
 * - **Nothing is published without an approval recorded by a person** (see {@link RiskApprovals}). The agent can
 *   only produce candidates.
 */

import type { FeatureBins } from './features.ts';

export interface Condition {
  feature: string;
  op: '>=' | '<=' | '=';
  value: number;
}

export interface RuleMetrics {
  window: string;
  evaluated: number;
  positives: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  f05: number;
  lift: number;
  coverage: number;
}

export interface Incremental {
  /** Positives caught by the new rule only. */
  newOnlyPositives: number;
  /** Positives caught by both. */
  sharedPositives: number;
  /** Positives the existing stack catches and the new rule misses. */
  existingOnlyPositives: number;
  /** Share of the new rule's hits that an existing rule already caught. */
  overlapShare: number;
  incrementalRecall: number;
}

export interface RuleCandidate {
  id: string;
  conditions: Condition[];
  expression: string;
  status: 'candidate' | 'approved' | 'published' | 'rejected';
  reasons: string[];
  train: RuleMetrics;
  holdout?: RuleMetrics;
  incremental?: Incremental;
}

export interface RiskEvent {
  id: string;
  date: string;
  window: string;
  label: 0 | 1;
  features: Record<string, number>;
  fields: Record<string, number>;
}

export interface SynthesizeOptions {
  /** Precision the rule must reach on the holdout to be recommended. */
  minPrecision?: number;
  /** Recall the rule must reach on the holdout. */
  minRecall?: number;
  /** At most this many conditions per rule. */
  maxConditions?: number;
  /** How many features to try combinations over. */
  topFeatures?: number;
  existingRules?: { id: string; expression: string }[];
}

const DEFAULTS = { minPrecision: 0.75, minRecall: 0.15, maxConditions: 3, topFeatures: 4 };

const QUANTILES = [0.5, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.99];

export interface FeatureSpec {
  name: string;
  bins: FeatureBins[];
  /** Which side is risky, read from the AUC (≥0.5 means higher values are riskier). */
  direction: 'high' | 'low';
}

export function synthesizeRules(trainEvents: RiskEvent[], holdoutEvents: RiskEvent[], features: FeatureSpec[],
  options: SynthesizeOptions = {}): RuleCandidate[] {
  const settings = { ...DEFAULTS, ...options };
  const candidates: RuleCandidate[] = [];

  // --- single conditions, one best per feature
  for (const spec of features) {
    const feature = spec.name;
    const direction = spec.direction;
    const values = trainEvents.map((event) => event.features[feature]).filter((value): value is number => Number.isFinite(value));
    if (values.length === 0) continue;
    let best: { condition: Condition; metrics: RuleMetrics } | null = null;
    // A boolean feature reads better as `= 1` than as `>= 1`, and an analyst reviewing the rule will read it.
    const isBoolean = values.every((value) => value === 0 || value === 1);
    for (const quantile of QUANTILES) {
      const threshold = quantileValue(values, direction === 'high' ? quantile : 1 - quantile);
      const condition: Condition = {
        feature,
        op: isBoolean ? '=' : direction === 'high' ? '>=' : '<=',
        value: isBoolean ? (direction === 'high' ? 1 : 0) : round(threshold, 6),
      };
      const metrics = backtest([condition], trainEvents, 'train');
      if (!best || metrics.f05 > best.metrics.f05) best = { condition, metrics };
    }
    if (best) {
      candidates.push(build(`R-NEW-${String(candidates.length + 1).padStart(2, '0')}`, [best.condition],
        best.metrics, holdoutEvents, settings));
    }
  }

  // --- pairs and one triple over the strongest features: a conjunction is how precision is bought
  const ranked = [...candidates].sort((a, b) => b.train.f05 - a.train.f05).slice(0, settings.topFeatures);
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const pair = [ranked[i]!.conditions[0]!, ranked[j]!.conditions[0]!];
      if (pair[0]!.feature === pair[1]!.feature) continue;
      const metrics = backtest(pair, trainEvents, 'train');
      candidates.push(build(`R-NEW-${String(candidates.length + 1).padStart(2, '0')}`, pair, metrics, holdoutEvents, settings));
    }
  }
  const pairRanked = [...candidates].filter((candidate) => candidate.conditions.length === 2)
    .sort((a, b) => b.train.f05 - a.train.f05).slice(0, 2);
  if (settings.maxConditions >= 3) {
    const third = ranked.find((candidate) => !pairRanked[0]?.conditions.some((condition) => condition.feature === candidate.conditions[0]!.feature));
    if (pairRanked[0] && third) {
      const triple = [...pairRanked[0].conditions, third.conditions[0]!];
      const metrics = backtest(triple, trainEvents, 'train');
      candidates.push(build('R-NEW-99', triple, metrics, holdoutEvents, settings));
    }
  }

  // --- the gate uses the holdout, not the training window
  for (const candidate of candidates) {
    const verdict = candidate.holdout ?? candidate.train;
    if (verdict.precision < settings.minPrecision) {
      candidate.reasons.push(`holdout precision ${verdict.precision} < ${settings.minPrecision}`);
    }
    if (verdict.recall < settings.minRecall) {
      candidate.reasons.push(`holdout recall ${verdict.recall} < ${settings.minRecall}`);
    }
    if (candidate.conditions.length > settings.maxConditions) {
      candidate.reasons.push(`more than ${settings.maxConditions} conditions`);
    }
    candidate.status = candidate.reasons.length === 0 ? 'candidate' : 'rejected';
  }

  return candidates.sort((a, b) => (b.status === 'candidate' ? 1 : 0) - (a.status === 'candidate' ? 1 : 0)
    || (b.holdout?.f05 ?? b.train.f05) - (a.holdout?.f05 ?? a.train.f05));
}

function build(id: string, conditions: Condition[], train: RuleMetrics, holdoutEvents: RiskEvent[],
  settings: typeof DEFAULTS): RuleCandidate {
  const holdout = holdoutEvents.length > 0 ? backtest(conditions, holdoutEvents, 'holdout') : undefined;
  return {
    id,
    conditions,
    expression: conditions.map((condition) => `${condition.feature} ${condition.op} ${condition.value}`).join(' AND '),
    status: 'candidate',
    reasons: [],
    train,
    ...(holdout ? { holdout } : {}),
    incremental: undefined,
  };
}

/** Confusion matrix, and the rates risk teams quote. */
export function backtest(conditions: Condition[], events: RiskEvent[], window: string): RuleMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const event of events) {
    const hit = matches(conditions, event);
    if (hit && event.label === 1) tp++;
    else if (hit && event.label === 0) fp++;
    else if (!hit && event.label === 1) fn++;
    else tn++;
  }
  const positives = tp + fn;
  const negatives = fp + tn;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = positives === 0 ? 0 : tp / positives;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const beta2 = 0.25;
  const f05 = precision + recall === 0 ? 0 : ((1 + beta2) * precision * recall) / (beta2 * precision + recall);
  const baseRate = positives + negatives === 0 ? 0 : positives / (positives + negatives);
  return {
    window,
    evaluated: events.length,
    positives,
    tp, fp, fn, tn,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    f05: round(f05),
    lift: round(baseRate === 0 || precision === 0 ? 0 : precision / baseRate),
    coverage: round(events.length === 0 ? 0 : (tp + fp) / events.length),
  };
}

export function matches(conditions: Condition[], event: RiskEvent): boolean {
  return conditions.every((condition) => {
    const value = event.features[condition.feature] ?? event.fields[condition.feature];
    if (!Number.isFinite(value)) return false;
    if (condition.op === '>=') return value >= condition.value;
    if (condition.op === '<=') return value <= condition.value;
    return value === condition.value;
  });
}

/**
 * How much the new rule adds to the rules already live.
 *
 * The number that matters is `incrementalRecall`: frauds the current stack misses and this rule catches. A rule
 * with 90% overlap and no new positives is a rename, not a new control.
 */
export function incrementOf(candidate: RuleCandidate, events: RiskEvent[], existing: { id: string; expression: string }[]): Incremental {
  const parsed = existing.map((rule) => ({ id: rule.id, conditions: parseExpression(rule.expression) }));
  let newOnlyPositives = 0;
  let sharedPositives = 0;
  let existingOnlyPositives = 0;
  let newHits = 0;
  let sharedHits = 0;
  let totalPositives = 0;

  for (const event of events) {
    if (event.label === 1) totalPositives++;
    const byNew = matches(candidate.conditions, event);
    const byExisting = parsed.some((rule) => rule.conditions.length > 0 && matches(rule.conditions, event));
    if (byNew) newHits++;
    if (byNew && byExisting) {
      sharedHits++;
      if (event.label === 1) sharedPositives++;
    } else if (byNew && event.label === 1) {
      newOnlyPositives++;
    }
    if (!byNew && byExisting && event.label === 1) existingOnlyPositives++;
  }

  return {
    newOnlyPositives,
    sharedPositives,
    existingOnlyPositives,
    overlapShare: newHits === 0 ? 0 : round(sharedHits / newHits),
    incrementalRecall: totalPositives === 0 ? 0 : round(newOnlyPositives / totalPositives),
  };
}

/** Parses the small conjunction grammar the rule table uses: `a >= 1 AND b = 0`. */
export function parseExpression(expression: string): Condition[] {
  const conditions: Condition[] = [];
  for (const part of expression.split(/\s+AND\s+/i)) {
    const match = /^\s*([A-Za-z_][\w.]*)\s*(>=|<=|=|>|<)\s*(-?[\d.]+)\s*$/.exec(part);
    if (!match) continue;
    const [, feature, operator, value] = match;
    const op: Condition['op'] = operator === '>' ? '>=' : operator === '<' ? '<=' : (operator as Condition['op']);
    conditions.push({ feature: feature!, op, value: Number(value) });
  }
  return conditions;
}

function quantileValue(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * (sorted.length - 1))));
  return sorted[position]!;
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
