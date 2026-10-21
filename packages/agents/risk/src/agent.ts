/**
 * M7: the risk-strategy agent - find the trend, test the features, propose a rule, measure it offline.
 *
 * The pipeline is the requirement, and the order is the discipline:
 *
 * ```
 * events + labels ──► trend (change point / spikes)
 *                  ──► features (AUC, KS, IV, PSI, monotonicity, point-in-time)
 *                  ──► rules   (≤3 conditions, thresholds from quantiles)
 *                  ──► backtest (train / holdout, plus incremental over the live stack)
 *                  ──► approval (a person, recorded; nothing auto-publishes)
 * ```
 *
 * Two things are deliberately *not* automatic:
 *
 * - **A rule is never published by the agent.** It can only reach `candidate`; publishing needs an approval line
 *   written by a person, and the published list is derived from those lines.
 * - **A leaking feature is never "discounted".** If any value was computed after the event it is rejected
 *   outright, because a future function's AUC is the best number in the file and the worst rule in production.
 */

import type { QueryRunner } from '../../../dataplane/src/sqlite.ts';
import type { AgentRefusal } from '../../../core/src/result.ts';
import { appendJsonl, readJsonl } from '../../../core/src/workspace.ts';
import { join } from 'node:path';
import { analyseTrend, type TrendReport } from './trend.ts';
import { evaluateFeature, type FeatureReport, type LabelledValue } from './features.ts';
import {
  incrementOf,
  synthesizeRules,
  type RuleCandidate,
  type RiskEvent,
} from './rules.ts';
import { narrate } from './narrate.ts';

export interface RiskOptions {
  run: QueryRunner;
  /** The graph whose approval log to read; also the id used in the log path. */
  graph?: string;
  /** Where approvals live: `<workspace>/risk/<graph>.approvals.jsonl`. */
  workspace?: string;
  /** Months held out for the backtest (the newest ones). */
  holdoutMonths?: number;
  minPrecision?: number;
  minRecall?: number;
  now?: string;
}

export interface RiskResult {
  agent: 'risk';
  window: { events: number; frauds: number; rate: number; from: string; to: string; holdout: { from: string; to: string } };
  trends: TrendReport[];
  features: FeatureReport[];
  rejectedFeatures: FeatureReport[];
  rules: RuleCandidate[];
  published: { id: string; expression: string; approvedBy: string; approvedAt: string; holdoutPrecision: number; holdoutRecall: number }[];
  explanation: string;
  limits: string[];
  confidence: { score: number; warnings: string[] };
  cost: { queries: number; events: number; features: number; ms: number };
  refusals: AgentRefusal[];
  evidence: { sql: string[] };
}

export interface Approval {
  ts: string;
  actor: string;
  ruleId: string;
  decision: 'approve' | 'reject';
  expression: string;
  note: string;
}

const DEFAULTS = { holdoutMonths: 3, minPrecision: 0.75, minRecall: 0.15 };

export function riskAgent(options: RiskOptions): RiskResult {
  const settings = {
    holdoutMonths: options.holdoutMonths ?? DEFAULTS.holdoutMonths,
    minPrecision: options.minPrecision ?? DEFAULTS.minPrecision,
    minRecall: options.minRecall ?? DEFAULTS.minRecall,
  };
  const started = performance.now();
  const counter = { queries: 0, sql: [] as string[] };
  const runQuery = (sql: string) => {
    counter.queries++;
    counter.sql.push(sql);
    return options.run(sql);
  };

  // --- 1. events and their labels
  const eventRows = runQuery(
    `SELECT event_id, event_date, region_id, channel_id, amount, is_fraud
     FROM risk_event ORDER BY event_date, event_id`,
  ).rows;
  if (eventRows.length === 0) {
    return refuse(counter, 'unvalidated', 'the risk table has no events', 'load risk_event before asking for a trend');
  }
  const frauds = eventRows.filter((row) => Number(row.is_fraud) === 1).length;
  if (eventRows.length < 100 || frauds < 30) {
    return refuse(counter, 'unvalidated',
      `only ${eventRows.length} events and ${frauds} positives: one rule and one trend need a few hundred events`,
      'widen the window or lower the label threshold before building rules');
  }

  // --- 2. the feature snapshots, with the point-in-time check done per value
  const featureRows = runQuery(
    'SELECT event_id, feature_name, value, as_of_date FROM feature_snapshot',
  ).rows;
  const registry = runQuery(
    'SELECT feature_name, owner, freshness_hours, available_before_event FROM feature_registry',
  ).rows;
  const registryByName = new Map(registry.map((row) => [String(row.feature_name), row]));

  const eventById = new Map<string, { date: string; month: string; label: 0 | 1; region: string; amount: number; features: Record<string, number> }>();
  for (const row of eventRows) {
    eventById.set(String(row.event_id), {
      date: String(row.event_date),
      month: String(row.event_date).slice(0, 7),
      label: Number(row.is_fraud) === 1 ? 1 : 0,
      region: String(row.region_id),
      amount: Number(row.amount),
      features: {},
    });
  }
  const valuesByFeature = new Map<string, LabelledValue[]>();
  for (const row of featureRows) {
    const event = eventById.get(String(row.event_id));
    if (!event) continue;
    const feature = String(row.feature_name);
    const value = Number(row.value);
    event.features[feature] = value;
    const list = valuesByFeature.get(feature) ?? [];
    list.push({
      value,
      label: event.label,
      // the whole point: a snapshot computed after the event cannot be used on that event
      asOfBeforeEvent: String(row.as_of_date) <= event.date,
      window: event.month,
    });
    valuesByFeature.set(feature, list);
  }

  // --- 3. the trend, per region, monthly.
  //
  // Monthly and not quarterly: with eight quarters a split test can only try the middle few splits without
  // leaving a segment too short, so a change two quarters from the end is invisible. Monthly gives 24 periods,
  // the detector can try splits from period 6 to 18, and the effect is still ~450 events per month per region.
  const trendRows = runQuery(
    `SELECT region_id, substr(event_date, 1, 7) AS period, COUNT(*) AS events, SUM(is_fraud) AS frauds
     FROM risk_event GROUP BY 1, 2 ORDER BY 1, 2`,
  ).rows;
  const byRegion = new Map<string, { period: string; events: number; frauds: number }[]>();
  for (const row of trendRows) {
    const region = String(row.region_id);
    const list = byRegion.get(region) ?? [];
    list.push({ period: String(row.period), events: Number(row.events), frauds: Number(row.frauds) });
    byRegion.set(region, list);
  }
  const trends: TrendReport[] = [...byRegion.entries()]
    .map(([region, rows]) => analyseTrend('region', region, rows, { minSegment: 6 }))
    .sort((a, b) => Math.abs(b.changePoint?.z ?? 0) - Math.abs(a.changePoint?.z ?? 0));
  const overall = analyseTrend('overall', 'all', trendRows.reduce<{ period: string; events: number; frauds: number }[]>((list, row) => {
    const period = String(row.period);
    const existing = list.find((entry) => entry.period === period);
    if (existing) {
      existing.events += Number(row.events);
      existing.frauds += Number(row.frauds);
    } else {
      list.push({ period, events: Number(row.events), frauds: Number(row.frauds) });
    }
    return list;
  }, []), { minSegment: 6 });
  trends.push(overall);

  // --- 4. feature effectiveness, point-in-time first
  const features: FeatureReport[] = [...valuesByFeature.entries()]
    .map(([name, values]) => evaluateFeature(name, values))
    .sort((a, b) => b.auc - a.auc);
  const rejectedFeatures = features.filter((feature) => !feature.usable);
  const usableFeatures = features.filter((feature) => feature.usable);
  if (usableFeatures.length === 0) {
    return refuse(counter, 'unvalidated', 'no feature passed the point-in-time and effectiveness checks',
      'check the feature registry and the snapshot dates; a feature computed after the event cannot be used');
  }

  // --- 5. rules on a train window, measured on a holdout the search never saw
  const months = [...new Set([...eventById.values()].map((event) => event.month))].sort();
  const holdoutStart = months[Math.max(0, months.length - settings.holdoutMonths)] ?? months[months.length - 1]!;
  const toEvent = (id: string): RiskEvent | null => {
    const event = eventById.get(id);
    if (!event) return null;
    const values = event.features;
    return {
      id,
      date: event.date,
      window: event.month,
      label: event.label,
      features: values,
      fields: { amount: event.amount },
    };
  };
  const trainEvents: RiskEvent[] = [];
  const holdoutEvents: RiskEvent[] = [];
  for (const [id, event] of eventById) {
    const target = event.month >= holdoutStart ? holdoutEvents : trainEvents;
    const converted = toEvent(id);
    if (converted) target.push(converted);
  }

  const featureSpecs = usableFeatures.map((feature) => ({
    name: feature.name,
    bins: feature.bins,
    direction: (feature.auc >= 0.5 ? 'high' : 'low') as 'high' | 'low',
  }));
  const existingRules = runQuery("SELECT rule_id, expression FROM risk_rule WHERE status = 'active'").rows
    .map((row) => ({ id: String(row.rule_id), expression: String(row.expression) }));
  const candidates = synthesizeRules(trainEvents, holdoutEvents, featureSpecs, {
    minPrecision: settings.minPrecision,
    minRecall: settings.minRecall,
    existingRules,
  }).slice(0, 8);

  for (const candidate of candidates) {
    candidate.incremental = incrementOf(candidate, holdoutEvents.length > 0 ? holdoutEvents : trainEvents, existingRules);
  }

  // --- 6. approvals decide what is published; the agent never publishes
  const approvals = new RiskApprovals(options.workspace ?? '.pag', options.graph ?? 'demo-analytics').decisions();
  const published: RiskResult['published'] = [];
  for (const candidate of candidates) {
    const decision = approvals.get(candidate.id);
    if (decision?.decision === 'approve') {
      candidate.status = 'published';
      published.push({
        id: candidate.id,
        expression: candidate.expression,
        approvedBy: decision.actor,
        approvedAt: decision.ts,
        holdoutPrecision: candidate.holdout?.precision ?? candidate.train.precision,
        holdoutRecall: candidate.holdout?.recall ?? candidate.train.recall,
      });
    } else if (decision?.decision === 'reject') {
      candidate.status = 'rejected';
      candidate.reasons.push(`rejected by ${decision.actor}: ${decision.note}`);
    }
  }

  const recommended = candidates.filter((candidate) => candidate.status === 'candidate' || candidate.status === 'published');
  const refusals: AgentRefusal[] = [];
  if (recommended.length === 0) {
    refusals.push({
      code: 'unvalidated',
      message: `no rule reached precision ${settings.minPrecision} at recall ${settings.minRecall} on the holdout window`,
      hint: 'the honest options are: gather labels for the new trend period, or accept a lower precision with the business owner',
    });
  }

  const warnings: string[] = [];
  const leaking = rejectedFeatures.filter((feature) => !feature.pointInTime.ok);
  if (leaking.length > 0) {
    warnings.push(`${leaking.length} feature(s) were rejected as future functions: ${leaking.map((feature) => feature.name).join(', ')}`);
  }
  if (holdoutEvents.length < 200 || holdoutEvents.filter((event) => event.label === 1).length < 15) {
    warnings.push('the holdout window is small: the backtest numbers are indicative, not a guarantee');
  }
  const bestTrend = trends.find((trend) => trend.changePoint !== null);

  const result: RiskResult = {
    agent: 'risk',
    window: {
      events: eventRows.length,
      frauds,
      rate: round(frauds / eventRows.length, 4),
      from: String(eventRows[0]!.event_date),
      to: String(eventRows[eventRows.length - 1]!.event_date),
      holdout: { from: holdoutStart, to: months[months.length - 1] ?? holdoutStart },
    },
    trends,
    features,
    rejectedFeatures,
    rules: candidates,
    published,
    explanation: '',
    limits: [],
    confidence: {
      score: Math.max(0.2, Math.min(0.9, 0.4 + (bestTrend?.changePoint?.z ?? 0) * 0.06
        - (recommended.length === 0 ? 0.2 : 0) - (holdoutEvents.length < 200 ? 0.1 : 0))),
      warnings,
    },
    cost: {
      queries: counter.queries,
      events: eventRows.length,
      features: features.length,
      ms: Math.round(performance.now() - started),
    },
    refusals,
    evidence: { sql: counter.sql },
  };
  result.explanation = narrate(result, settings);
  result.limits = [
    '规则不会自动上线：必须由风控负责人审批，审批记录是追加日志',
    '离线指标基于历史标签；上线后要监控命中率与误杀率，标签口径变化会使回测失效',
    'point-in-time 检查只覆盖快照日期；如果特征本身由未来信息训练（标签泄漏到模型里），这里看不出来',
    `holdout 是最近 ${settings.holdoutMonths} 个月；更早的规则效果不代表现在`,
  ];
  return result;
}

/**
 * The approval log: append-only, one line per decision.
 *
 * Deriving the published list from these lines (rather than from a mutable `status` field) is what makes "who
 * approved this rule, when, and on what evidence" answerable later.
 */
export class RiskApprovals {
  readonly path: string;
  /** Distinct signatures a decision needs. One is the default; a retirement may need two. */
  readonly quorum: number;
  constructor(workspace: string, graph: string, options: { quorum?: number } = {}) {
    this.path = join(workspace, 'risk', `${graph}.approvals.jsonl`);
    this.quorum = Math.max(1, options.quorum ?? 1);
  }

  all(): Approval[] {
    return readJsonl<Approval>(this.path);
  }

  /** Every signature for a rule, in order, with the actor named - the raw material for "who agreed, and when". */
  signatures(ruleId: string): Approval[] {
    return this.all().filter((entry) => entry.ruleId === ruleId);
  }

  /** How far a rule is from a decision: the distinct signers and what is still missing. */
  state(ruleId: string): { decision: 'approve' | 'reject' | null; signers: string[]; satisfied: boolean; required: number } {
    const entries = this.signatures(ruleId);
    const signers = [...new Set(entries.filter((entry) => entry.decision === 'approve').map((entry) => entry.actor))];
    const rejected = entries.some((entry) => entry.decision === 'reject');
    return {
      decision: rejected ? 'reject' : signers.length >= this.quorum ? 'approve' : null,
      signers,
      satisfied: rejected || signers.length >= this.quorum,
      required: this.quorum,
    };
  }

  /**
   * One signature. The same person signing twice is one signature, not two: a quorum of two actors who are the same
   * actor is not a control, and the log has to be the place that refuses it rather than the caller remembering to.
   */
  sign(ruleId: string, expression: string, decision: 'approve' | 'reject', actor: string,
    note: string, now = new Date().toISOString()): Approval {
    if (actor.trim().length === 0) throw new Error('an approval needs an actor: the log is the audit trail');
    const existing = this.signatures(ruleId);
    if (decision === 'approve' && existing.some((entry) => entry.decision === 'approve' && entry.actor === actor)) {
      throw new Error(`${actor} has already approved ${ruleId}: a second signature from the same person is not a second signature`);
    }
    const entry: Approval = { ts: now, actor, ruleId, decision, expression, note };
    appendJsonl(this.path, entry);
    return entry;
  }

  /** Records a signature and returns the decision once the quorum is met (a rejection is immediate). */
  decide(ruleId: string, expression: string, decision: 'approve' | 'reject', actor: string,
    note: string, now = new Date().toISOString()): Approval {
    return this.sign(ruleId, expression, decision, actor, note, now);
  }

  /**
   * The published set: a rule is published only when its quorum is met and it was not rejected.
   * Deriving this from the log (rather than a mutable status) is what makes the quorum checkable after the fact.
   */
  decisions(): Map<string, { decision: 'approve' | 'reject'; actor: string; ts: string; note: string }> {
    const map = new Map<string, { decision: 'approve' | 'reject'; actor: string; ts: string; note: string }>();
    const rules = new Set(this.all().map((entry) => entry.ruleId));
    for (const ruleId of rules) {
      const state = this.state(ruleId);
      if (!state.satisfied || state.decision === null) continue;
      const entries = this.signatures(ruleId);
      const deciding = state.decision === 'reject'
        ? entries.find((entry) => entry.decision === 'reject')!
        : entries.filter((entry) => entry.decision === 'approve').at(-1)!;
      map.set(ruleId, {
        decision: state.decision,
        actor: state.signers.join(' + '),
        ts: deciding.ts,
        note: deciding.note,
      });
    }
    return map;
  }
}

function refuse(counter: { queries: number; sql: string[] }, code: AgentRefusal['code'], message: string,
  hint?: string): RiskResult {
  return {
    agent: 'risk',
    window: { events: 0, frauds: 0, rate: 0, from: '', to: '', holdout: { from: '', to: '' } },
    trends: [],
    features: [],
    rejectedFeatures: [],
    rules: [],
    published: [],
    explanation: `无法给出风控建议：${message}`,
    limits: ['拒绝比编造一条规则好'],
    confidence: { score: 0, warnings: [message] },
    cost: { queries: counter.queries, events: 0, features: 0, ms: 0 },
    refusals: [{ code, message, ...(hint ? { hint } : {}) }],
    evidence: { sql: counter.sql },
  };
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
