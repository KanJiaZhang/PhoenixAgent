/**
 * Rule governance: what the live rules are actually worth, and what they cost.
 *
 * Building a rule is one question ("can this feature separate fraud?"); keeping a rule is another, and it is the
 * one nobody automates: rules accumulate, overlap, drift, and keep intercepting cases long after the behaviour
 * they were written for has gone. This module answers four questions per live rule, from data:
 *
 * | question | measurement |
 * | --- | --- |
 * | Does it catch anything? | hits, precision, recall, coverage on a holdout window |
 * | Does it catch anything *new*? | positives it hits alone, and the Jaccard overlap with each other rule |
 * | How much does it cost to run? | hits per day (every hit is an interception somebody has to clear) |
 * | Are its features still the same? | PSI of the features it uses, first half vs second half of the window |
 *
 * The verdict is a recommendation, not an action: `keep`, `retune` (drifted), `retire` (too imprecise, or fully
 * covered by another rule). Retiring is a decision for a person, recorded like an approval.
 */

import type { QueryRunner } from '../../../dataplane/src/sqlite.ts';
import { evaluateFeature, type LabelledValue } from './features.ts';
import { parseExpression, type RiskEvent } from './rules.ts';

export interface AuditedRule {
  ruleId: string;
  expression: string;
  conditions: number;
  hits: number;
  precision: number;
  recall: number;
  coverage: number;
  /** Positives this rule catches that no other live rule catches. */
  incrementalPositives: number;
  overlap: { ruleId: string; sharedHits: number; jaccard: number }[];
  /** Hits per day over the holdout window - the operational cost of the rule. */
  interceptsPerDay: number;
  drift: { feature: string; psi: number }[];
  verdict: 'keep' | 'retune' | 'retire';
  reasons: string[];
  /** For a `retune`: the threshold that would reach the precision gate on this window, if one exists. */
  retune?: { expression: string; precision: number; recall: number; hits: number };
  /** Set when even the tightest threshold cannot reach the gate: the rule needs a better feature, not a number. */
  retuneGap?: string;
}

export interface RuleAudit {
  window: { from: string; to: string; events: number; frauds: number; days: number };
  rules: AuditedRule[];
  summary: {
    keep: number; retune: number; retire: number;
    /** Recall if every rule marked `retire` were switched off, and the interceptions that would disappear. */
    afterRetire: { remainingRecall: number; removedInterceptsPerDay: number; lostPositives: number };
  };
  recommendation: string;
  limits: string[];
  cost: { queries: number; ms: number };
}

export interface AuditOptions {
  run: QueryRunner;
  /** Which months are the holdout (the newest ones). */
  holdoutMonths?: number;
  /** Below this precision a rule is recommended for retirement. */
  minPrecision?: number;
  /** PSI above this means the feature distribution moved and the threshold needs re-fitting. */
  driftThreshold?: number;
}

export function auditRules(options: AuditOptions): RuleAudit {
  const settings = { holdoutMonths: options.holdoutMonths ?? 6, minPrecision: options.minPrecision ?? 0.5, driftThreshold: 0.25 };
  const started = performance.now();
  let queries = 0;

  const rules = options.run("SELECT rule_id, expression FROM risk_rule WHERE status = 'active' ORDER BY rule_id").rows
    .map((row) => ({ id: String(row.rule_id), expression: String(row.expression) }));
  queries++;

  const eventRows = options.run('SELECT event_id, event_date, amount, is_fraud FROM risk_event ORDER BY event_date').rows;
  queries++;
  const featureRows = options.run('SELECT event_id, feature_name, value FROM feature_snapshot').rows;
  queries++;

  const months = [...new Set(eventRows.map((row) => String(row.event_date).slice(0, 7)))].sort();
  const holdoutStart = months[Math.max(0, months.length - settings.holdoutMonths)] ?? months[0]!;
  const featuresByEvent = new Map<string, Record<string, number>>();
  for (const row of featureRows) {
    const map = featuresByEvent.get(String(row.event_id)) ?? {};
    map[String(row.feature_name)] = Number(row.value);
    featuresByEvent.set(String(row.event_id), map);
  }

  const events: RiskEvent[] = eventRows
    .filter((row) => String(row.event_date).slice(0, 7) >= holdoutStart)
    .map((row) => ({
      id: String(row.event_id),
      date: String(row.event_date),
      window: String(row.event_date).slice(0, 7),
      label: Number(row.is_fraud) === 1 ? 1 : 0,
      features: featuresByEvent.get(String(row.event_id)) ?? {},
      fields: { amount: Number(row.amount) },
    }));
  const positives = events.filter((event) => event.label === 1).length;
  const days = Math.max(1, new Set(events.map((event) => event.date)).size);

  const hitSets = rules.map((rule) => {
    const conditions = parseExpression(rule.expression);
    return { rule, conditions, hits: new Set(events.filter((event) => matchesAll(conditions, event)).map((event) => event.id)) };
  });

  const audited: AuditedRule[] = hitSets.map((entry) => {
    const hitEvents = events.filter((event) => entry.hits.has(event.id));
    const truePositives = hitEvents.filter((event) => event.label === 1).length;
    const others = hitSets.filter((other) => other.rule.id !== entry.rule.id);
    const onlyThis = hitEvents.filter((event) => event.label === 1
      && !others.some((other) => other.hits.has(event.id))).length;
    const overlap = others.map((other) => {
      const shared = [...entry.hits].filter((id) => other.hits.has(id)).length;
      const union = new Set([...entry.hits, ...other.hits]).size;
      return { ruleId: other.rule.id, sharedHits: shared, jaccard: union === 0 ? 0 : round(shared / union, 3) };
    });

    const featuresUsed = [...new Set(entry.conditions.map((condition) => condition.feature))];
    const drift = featuresUsed.map((feature) => ({
      feature,
      psi: driftOf(events, feature, settings.driftThreshold),
    }));

    const precision = hitEvents.length === 0 ? 0 : truePositives / hitEvents.length;
    const reasons: string[] = [];
    if (hitEvents.length === 0) reasons.push('在 holdout 窗口内一次都没命中');
    if (precision < settings.minPrecision) reasons.push(`精确率 ${round(precision, 3)} 低于门槛 ${settings.minPrecision}`);
    if (onlyThis === 0 && others.length > 0) reasons.push('命中的欺诈都能被其他规则覆盖（新增为 0）');
    const drifted = drift.filter((entry) => Number.isFinite(entry.psi) && entry.psi > settings.driftThreshold);
    if (drifted.length > 0) reasons.push(`特征漂移 PSI=${drifted.map((entry) => entry.psi.toFixed(3)).join('/')}，阈值需要重拟合`);

    // A rule that is imprecise *and* the only thing catching most of the fraud is not a rule to retire: it is a
    // rule to retune. Retiring the recall backbone because its precision is low would take detection to zero,
    // and "precision above all" is not how a fraud stack works - it is precision *at an acceptable recall*.
    const exclusiveShare = positives === 0 ? 0 : onlyThis / positives;
    const backbone = exclusiveShare >= 0.05;
    if (precision < settings.minPrecision && backbone) {
      reasons.push(`但它是召回主力（独占 ${onlyThis} 个欺诈，占 ${(exclusiveShare * 100).toFixed(1)}%）：应上调阈值而不是下线`);
    }
    const verdict: AuditedRule['verdict'] = hitEvents.length === 0 || (onlyThis === 0 && others.length > 0)
      ? 'retire'
      : precision < settings.minPrecision
        ? (backbone ? 'retune' : 'retire')
        : drifted.length > 0 ? 'retune' : 'keep';
    const tuning = verdict === 'retune' ? proposeThreshold(entry.conditions, events, settings.minPrecision) : undefined;

    return {
      ruleId: entry.rule.id,
      expression: entry.rule.expression,
      conditions: entry.conditions.length,
      hits: hitEvents.length,
      precision: round(precision, 4),
      recall: positives === 0 ? 0 : round(truePositives / positives, 4),
      coverage: events.length === 0 ? 0 : round(hitEvents.length / events.length, 4),
      incrementalPositives: onlyThis,
      overlap,
      interceptsPerDay: round(hitEvents.length / days, 2),
      drift,
      verdict,
      reasons,
      ...(tuning?.suggestion ? { retune: tuning.suggestion } : {}),
      ...(tuning && !tuning.suggestion ? { retuneGap: tuning.gap } : {}),
    };
  });

  const retired = new Set(audited.filter((rule) => rule.verdict === 'retire').map((rule) => rule.ruleId));
  const survivors = hitSets.filter((entry) => !retired.has(entry.rule.id));
  const survivorHits = new Set(survivors.flatMap((entry) => [...entry.hits]));
  const caughtBySurvivors = events.filter((event) => event.label === 1 && survivorHits.has(event.id)).length;
  // "Lost" is what only a retired rule would have caught: a positive another surviving rule also catches is not
  // lost, and a positive nobody caught was never caught to begin with.
  const retiredHits = new Set(hitSets.filter((entry) => retired.has(entry.rule.id)).flatMap((entry) => [...entry.hits]));
  const lostPositives = events.filter((event) => event.label === 1 && retiredHits.has(event.id)
    && !survivorHits.has(event.id)).length;
  const summary = {
    keep: audited.filter((rule) => rule.verdict === 'keep').length,
    retune: audited.filter((rule) => rule.verdict === 'retune').length,
    retire: retired.size,
    afterRetire: {
      remainingRecall: positives === 0 ? 0 : round(caughtBySurvivors / positives, 4),
      removedInterceptsPerDay: round(audited.filter((rule) => retired.has(rule.ruleId))
        .reduce((sum, rule) => sum + rule.interceptsPerDay, 0), 2),
      lostPositives,
    },
  };
  const retire = audited.filter((rule) => rule.verdict === 'retire');
  const recommendation = retire.length > 0
    ? `建议下线 ${retire.map((rule) => rule.ruleId).join('、')}：${retire.map((rule) => rule.reasons[0]).join('；')}`
      + `（预期每天少 ${retire.reduce((sum, rule) => sum + rule.interceptsPerDay, 0).toFixed(1)} 次拦截，需人工确认误杀影响）`
    : audited.some((rule) => rule.verdict === 'retune')
      ? `建议重拟合 ${audited.filter((rule) => rule.verdict === 'retune').map((rule) => rule.ruleId).join('、')} 的阈值`
      : '现有规则都还在工作，暂时不需要动作';

  return {
    window: { from: holdoutStart, to: months[months.length - 1] ?? holdoutStart, events: events.length, frauds: positives, days },
    rules: audited,
    summary,
    recommendation,
    limits: [
      '巡检只基于历史标签：标签缺失的近期事件未计入精确率',
      '重叠用命中集合的 Jaccard：两条规则可能针对不同人群但在这里看起来相似',
      '容量只算命中次数，不含人工审核成本与误杀赔付',
      'vertict 是建议，下线仍需人工确认并留审批记录',
    ],
    cost: { queries, ms: Math.round(performance.now() - started) },
  };
}

/**
 * The threshold a `retune` verdict should carry: the tightest cut on the rule's first numeric condition that
 * reaches the precision gate while keeping as much recall as possible. A verdict without a replacement value is
 * a complaint, not a recommendation.
 */
function proposeThreshold(conditions: ReturnType<typeof parseExpression>, events: RiskEvent[], minPrecision: number):
{ suggestion?: { expression: string; precision: number; recall: number; hits: number }; gap?: string } {
  const target = conditions.find((condition) => condition.op !== '=');
  if (!target) return { gap: '规则里没有可调的数值阈值' };
  const positives = events.filter((event) => event.label === 1).length;
  const values = events.map((event) => event.features[target.feature])
    .filter((value): value is number => Number.isFinite(value));
  if (values.length === 0) return { gap: `特征 ${target.feature} 在窗口内没有值` };
  let best: { expression: string; precision: number; recall: number; hits: number } | undefined;
  let tightest = { precision: 0, expression: '' };
  for (const quantile of [0.5, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.99]) {
    const sorted = [...values].sort((a, b) => a - b);
    const threshold = sorted[Math.min(sorted.length - 1, Math.floor((target.op === '>=' ? quantile : 1 - quantile) * (sorted.length - 1)))]!;
    const candidate = conditions.map((condition) => condition === target
      ? { ...condition, value: round(threshold, 6) }
      : condition);
    const hits = events.filter((event) => matchesAll(candidate, event));
    const truePositives = hits.filter((event) => event.label === 1).length;
    const precision = hits.length === 0 ? 0 : truePositives / hits.length;
    if (precision > tightest.precision) {
      tightest = {
        precision: round(precision, 4),
        expression: candidate.map((condition) => `${condition.feature} ${condition.op} ${condition.value}`).join(' AND '),
      };
    }
    if (precision < minPrecision) continue;
    const recall = positives === 0 ? 0 : truePositives / positives;
    if (!best || recall > best.recall) {
      best = {
        expression: candidate.map((condition) => `${condition.feature} ${condition.op} ${condition.value}`).join(' AND '),
        precision: round(precision, 4), recall: round(recall, 4), hits: hits.length,
      };
    }
  }
  if (best) return { suggestion: best };
  // Honest failure: a threshold cannot manufacture signal. Say the best it can do and stop.
  return {
    gap: `即使把阈值收到最紧（${tightest.expression}），精确率也只有 ${tightest.precision}（门槛 ${minPrecision}）：`
      + '这条规则需要更强的特征或组合条件，调阈值解决不了',
  };
}

function matchesAll(conditions: ReturnType<typeof parseExpression>, event: RiskEvent): boolean {
  return conditions.every((condition) => {
    const value = event.features[condition.feature] ?? event.fields[condition.feature];
    if (!Number.isFinite(value)) return false;
    if (condition.op === '>=') return value >= condition.value;
    if (condition.op === '<=') return value <= condition.value;
    return value === condition.value;
  });
}

/** PSI of one feature between the first and second half of the audited window. */
function driftOf(events: RiskEvent[], feature: string, _threshold: number): number {
  const months = [...new Set(events.map((event) => event.window))].sort();
  if (months.length < 2) return Number.NaN;
  const middle = months[Math.floor(months.length / 2)]!;
  const values: LabelledValue[] = events
    .filter((event) => Number.isFinite(event.features[feature]))
    .map((event) => ({
      value: event.features[feature]!,
      label: event.label,
      asOfBeforeEvent: true,
      window: event.window >= middle ? 'late' : 'early',
    }));
  if (values.length === 0) return Number.NaN;
  const report = evaluateFeature(feature, values, { minPositives: 1 });
  return report.psi;
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
