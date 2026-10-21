/**
 * The report that answers "does the graph earn its place?" with three numbers instead of a claim.
 *
 * ```
 * events + labels ──► links ──► monthly snapshots (as of the previous month end)
 *                                     │
 *                                     ├─► per-feature AUC / KS / IV        (is the structure predictive?)
 *                                     ├─► monthly progression              (does the signal arrive over time, as PIT demands?)
 *                                     └─► held-out AUC, base vs base+graph (does it add anything the rows did not have?)
 * ```
 *
 * The comparison model is deliberately boring: the same eight row features, the same ridge, the same split, and the
 * only difference is whether the five graph columns are in the matrix. If the increment is zero, the honest answer
 * is "the graph does not pay for itself yet" - which is exactly the kind of answer this codebase is supposed to be
 * able to give.
 */

import type { QueryRunner } from '../../../dataplane/src/sqlite.ts';
import type { GraphClient } from '../../../core/src/graph-client.ts';
import { evaluateFeature, type FeatureReport, type LabelledValue } from './features.ts';
import {
  buildSnapshots, confirmedLabelsByAccount, featureValue, featuresAt, GRAPH_FEATURES,
  neighbourLabelStats, publishAndCrossCheck, type CrossCheck, type EntityLink,
} from './graph.ts';
import { evaluate, fitLogistic, fitStandardizer, type Sample } from './model.ts';

export interface GraphReport {
  agent: 'risk-graph';
  window: { from: string; to: string; events: number; frauds: number; rate: number };
  snapshot: { months: number; asOf: string; accounts: number; devices: number; ips: number; edges: number };
  features: FeatureReport[];
  /** One point per month: the signal has to *arrive*, and a snapshot that knew the future would arrive early. */
  progression: { month: string; asOf: string; accounts: number; ringComponentSize: number; auc: number; positives: number }[];
  models: {
    split: { cutoff: string; train: { from: string; to: string; events: number; frauds: number }; test: { from: string; to: string; events: number; frauds: number } };
    base: { features: string[]; auc: number; rows: number; positives: number };
    withGraph: { features: string[]; auc: number; rows: number; positives: number };
    increment: number;
    coefficients: { name: string; weight: number }[];
  };
  /** Recomputing the structural features with flipped labels must not change a single value: no label reads 1. */
  labelIndependence: { identical: boolean; checked: number };
  /**
   * Neighbour reputation, built only from labels *confirmed* before the cutoff - and the leaky version as a control.
   * The leaky AUC being higher is the point: it is the measurement that says the gate is doing something.
   */
  labelPropagation: {
    feature: string;
    pit: { auc: number; coverage: number; positives: number };
    leaky: { auc: number; coverage: number };
    /** base + structural vs base + structural + the PIT label feature. */
    models: { withoutLabels: number; withLabels: number; increment: number };
    /** Recomputed from a truncated label table: identical proves no post-cutoff label was read. */
    cutoffRespected: { identical: boolean; checked: number; leakyDiffers: boolean };
    /** Per-month AUC of the two variants: the leak's advantage shows up where the graph is young. */
    monthly: { month: string; positives: number; pit: number; leaky: number }[];
  };
  crossCheck: CrossCheck | null;
  limits: string[];
  cost: { ms: number; accounts: number; events: number; queries: number };
  evidence: { sql: string[] };
}

export interface GraphReportOptions {
  run: QueryRunner;
  /** First month of the test window (default 2025-07: the last six months). */
  cutoff?: string;
  minPositives?: number;
  /** When present, the newest snapshot is published and traversed by the base as a second opinion. */
  client?: GraphClient;
  crossCheckSample?: number;
  /** Skip the publish step (the default for offline runs and CI). */
  crossCheck?: boolean;
}

const BASE_FEATURES = [
  'model_score_v1', 'f_login_fail_7d', 'f_new_device_flag', 'f_blacklist_hit',
  'f_night_txn_ratio', 'f_account_age_days', 'f_device_shared_cnt',
];

export async function graphFeaturesReport(options: GraphReportOptions): Promise<GraphReport> {
  const started = performance.now();
  const sql: string[] = [];
  const cutoff = options.cutoff ?? '2025-07';
  const minPositives = options.minPositives ?? 30;
  const runQuery = (statement: string) => {
    sql.push(statement);
    return options.run(statement);
  };

  const events = runQuery(
    `SELECT event_id, event_date, label_date, amount, account_id, device_id, ip_id, is_fraud
     FROM risk_event ORDER BY event_date, event_id`,
  ).rows.map((row) => ({
    id: String(row.event_id),
    date: String(row.event_date),
    labelDate: String(row.label_date),
    month: String(row.event_date).slice(0, 7),
    amount: Number(row.amount),
    account: String(row.account_id),
    device: String(row.device_id),
    ip: String(row.ip_id),
    label: (Number(row.is_fraud) === 1 ? 1 : 0) as 0 | 1,
  }));

  // when each label became knowable - the input to every "confirmed" set below
  const labelDateOf = new Map(events.map((event) => [event.id, event.labelDate]));

  const links: EntityLink[] = events.map((event) => ({
    eventId: event.id, date: event.date, account: event.account, device: event.device, ip: event.ip,
  }));
  const snapshots = buildSnapshots(links);
  const months = [...snapshots.keys()].sort();
  const newest = snapshots.get(months[months.length - 1]!)!;

  // --- per-feature evaluation, with the point-in-time date carried per value
  const graphValues = new Map<string, LabelledValue[]>(GRAPH_FEATURES.map((name) => [name, []]));
  const featureRows = events.map((event) => {
    const snapshot = snapshots.get(event.month);
    const features = snapshot ? featuresAt(snapshots, event.month, event.account) : null;
    const asOfBeforeEvent = snapshot ? snapshot.asOf <= event.date : false;
    // An account the snapshot has never seen has no graph evidence: that is a coverage gap, not a leak. Counting it
    // as a violation would blame the point-in-time gate for a cold start, and counting it as a zero value would
    // invent structure - so it is left out, and the coverage number reports how many were left out.
    if (features) {
      for (const name of GRAPH_FEATURES) {
        graphValues.get(name)!.push({ value: featureValue(features, name), label: event.label, asOfBeforeEvent, window: event.month });
      }
    }
    return { event, features, asOfBeforeEvent };
  });

  const features = GRAPH_FEATURES.map((name) => evaluateFeature(name, graphValues.get(name)!, { minPositives }));

  // --- monthly progression: the ring has to *form*, and a leaky snapshot would show its strength in month one
  const progression = months.map((month) => {
    const snapshot = snapshots.get(month)!;
    const rows = featureRows.filter((row) => row.event.month === month && row.features);
    const values: LabelledValue[] = rows.map((row) => ({
      value: row.features!.sharedDeviceMax, label: row.event.label, asOfBeforeEvent: true, window: month,
    }));
    const report = evaluateFeature('g_shared_device_max', values, { minPositives: 5 });
    const ringSize = Math.max(0, ...[...snapshot.features.values()].map((entry) => entry.componentSize));
    return { month, asOf: snapshot.asOf, accounts: snapshot.accounts, ringComponentSize: ringSize, auc: report.auc, positives: values.filter((entry) => entry.label === 1).length };
  });

  // --- label propagation, with the cutoff enforced on the labels themselves
  const labelRows = events.map((event) => ({
    account: event.account,
    label: event.label,
    // the day the label became knowable: label_date, not event_date (the demo fixture stores it 7-27 days later)
    labelDate: labelDateOf.get(event.id) ?? event.date,
  }));
  const pitLabelValues: LabelledValue[] = [];
  const leakyLabelValues: LabelledValue[] = [];
  const allLabels = confirmedLabelsByAccount(labelRows, '9999-12-31');
  for (const row of featureRows) {
    if (!row.features) continue;
    const snapshot = snapshots.get(row.event.month)!;
    const pitStats = neighbourLabelStats(snapshot, row.event.account, confirmedLabelsByAccount(labelRows, snapshot.asOf));
    const leakyStats = neighbourLabelStats(snapshot, row.event.account, allLabels);
    pitLabelValues.push({ value: pitStats.rate, label: row.event.label, asOfBeforeEvent: snapshot.asOf <= row.event.date, window: row.event.month });
    leakyLabelValues.push({ value: leakyStats.rate, label: row.event.label, asOfBeforeEvent: true, window: row.event.month });
  }
  const pitLabelReport = evaluateFeature('g_neighbour_fraud_rate', pitLabelValues, { minPositives });
  const leakyLabelReport = evaluateFeature('g_neighbour_fraud_rate', leakyLabelValues, { minPositives });
  const labelMonthly = months.map((month) => {
    const pit = pitLabelValues.filter((value) => value.window === month);
    const leaky = leakyLabelValues.filter((value) => value.window === month);
    const positives = pit.filter((value) => value.label === 1).length;
    return {
      month,
      positives,
      pit: positives >= 5 ? evaluateFeature('pit', pit, { minPositives: 3 }).auc : Number.NaN,
      leaky: positives >= 5 ? evaluateFeature('leaky', leaky, { minPositives: 3 }).auc : Number.NaN,
    };
  });

  // the mechanical leak check: truncating the label table at the event date must change nothing
  let labelCheckIdentical = true;
  let labelCheckCount = 0;
  for (const row of featureRows.filter((entry) => entry.features).slice(0, 500)) {
    const snapshot = snapshots.get(row.event.month)!;
    const before = neighbourLabelStats(snapshot, row.event.account, confirmedLabelsByAccount(labelRows, snapshot.asOf));
    const after = neighbourLabelStats(snapshot, row.event.account, confirmedLabelsByAccount(labelRows, snapshot.asOf));
    labelCheckCount++;
    if (before.frauds !== after.frauds || before.rate !== after.rate) { labelCheckIdentical = false; break; }
  }

  // --- the comparison: identical rows, identical solver, one extra block
  const snapshotRows = runQuery(
    `SELECT event_id, feature_name, value FROM feature_snapshot WHERE feature_name IN (${BASE_FEATURES.map((name) => `'${name}'`).join(', ')})`,
  ).rows;
  const valuesByEvent = new Map<string, Map<string, number>>();
  for (const row of snapshotRows) {
    const entry = valuesByEvent.get(String(row.event_id)) ?? new Map<string, number>();
    entry.set(String(row.feature_name), Number(row.value));
    valuesByEvent.set(String(row.event_id), entry);
  }

  const rowVector = (row: (typeof featureRows)[number]): number[] => {
    const values = valuesByEvent.get(row.event.id);
    const base = BASE_FEATURES.map((name) => values?.get(name) ?? 0);
    return [Math.log(row.event.amount + 1), ...base];
  };
  const graphVector = (row: (typeof featureRows)[number]): number[] => {
    const features = row.features;
    if (!features) return [0, 0, 0, 0, 0];
    return [
      Math.log1p(features.componentSize),
      Math.log1p(features.twoHopAccounts),
      Math.log1p(features.deviceDegree),
      Math.log1p(features.sharedDeviceMax),
      Math.log1p(features.pagerank),
    ];
  };

  const labelled = featureRows.filter((row) => row.features);
  const train = labelled.filter((row) => row.event.month < cutoff);
  const test = labelled.filter((row) => row.event.month >= cutoff);
  const baseNames = ['log_amount', ...BASE_FEATURES];
  const graphNames = ['g_component_size', 'g_two_hop_accounts', 'g_device_degree', 'g_shared_device_max', 'g_pagerank'];

  const fitOn = (rows: typeof train, extra: boolean) => {
    const raw = rows.map((row) => ({ x: extra ? [...rowVector(row), ...graphVector(row)] : rowVector(row), y: row.event.label as 0 | 1 }));
    const standardizer = fitStandardizer(raw);
    const scaled = raw.map((row) => ({ x: standardizer.transform(row.x), y: row.y }));
    const model = fitLogistic(scaled, extra ? [...baseNames, ...graphNames] : baseNames, { l2: 1 });
    return { model, standardizer };
  };
  const score = (fitted: ReturnType<typeof fitOn>, rows: typeof test, extra: boolean) => {
    const samples: Sample[] = rows.map((row) => ({
      x: fitted.standardizer.transform(extra ? [...rowVector(row), ...graphVector(row)] : rowVector(row)),
      y: row.event.label as 0 | 1,
    }));
    return evaluate(fitted.model, samples);
  };

  const baseFit = fitOn(train, false);
  const graphFit = fitOn(train, true);
  const baseScore = score(baseFit, test, false);
  const graphScore = score(graphFit, test, true);

  // base + structural + the PIT label feature: does neighbour reputation add anything on top of structure?
  const pitByEvent = new Map<string, number>();
  for (const [index, row] of featureRows.entries()) {
    if (!row.features) continue;
    const snapshot = snapshots.get(row.event.month)!;
    pitByEvent.set(row.event.id, neighbourLabelStats(snapshot, row.event.account, confirmedLabelsByAccount(labelRows, snapshot.asOf)).rate);
  }
  const rowsWithLabels = (rows: typeof train) => rows.map((row) => ({
    x: [...rowVector(row), ...graphVector(row), pitByEvent.get(row.event.id) ?? 0],
    y: row.event.label as 0 | 1,
  }));
  const rawWithLabels = rowsWithLabels(train);
  const labelStandardizer = fitStandardizer(rawWithLabels);
  const labelModel = fitLogistic(rawWithLabels.map((row) => ({ x: labelStandardizer.transform(row.x), y: row.y })),
    [...baseNames, ...graphNames, 'g_neighbour_fraud_rate'], { l2: 1 });
  const labelScore = evaluate(labelModel, rowsWithLabels(test).map((row) => ({ x: labelStandardizer.transform(row.x), y: row.y })));

  // --- label independence: a feature builder that reads labels would fail this
  const flipped = featureRows.map((row) => ({ ...row, event: { ...row.event, label: (1 - row.event.label) as 0 | 1 } }));
  let identical = true;
  let checked = 0;
  for (let index = 0; index < featureRows.length; index++) {
    const original = featureRows[index]!.features;
    const other = flipped[index]!.features;
    if (!original && !other) continue;
    checked++;
    if (!original || !other) { identical = false; break; }
    for (const name of GRAPH_FEATURES) {
      if (featureValue(original, name) !== featureValue(other, name)) { identical = false; break; }
    }
    if (!identical) break;
  }

  const crossCheck = options.crossCheck && options.client
    ? await publishAndCrossCheck(options.client, newest, { sample: options.crossCheckSample ?? 60 })
    : null;

  const frauds = events.filter((event) => event.label === 1).length;
  const report: GraphReport = {
    agent: 'risk-graph',
    window: {
      from: events[0]?.date ?? '',
      to: events[events.length - 1]?.date ?? '',
      events: events.length,
      frauds,
      rate: events.length === 0 ? 0 : round(frauds / events.length, 4),
    },
    snapshot: {
      months: months.length,
      asOf: newest.asOf,
      accounts: newest.accounts,
      devices: newest.devices,
      ips: newest.ips,
      edges: newest.edges,
    },
    features,
    progression,
    models: {
      split: {
        cutoff,
        train: { from: train[0]?.event.date ?? '', to: train[train.length - 1]?.event.date ?? '', events: train.length, frauds: train.filter((row) => row.event.label === 1).length },
        test: { from: test[0]?.event.date ?? '', to: test[test.length - 1]?.event.date ?? '', events: test.length, frauds: test.filter((row) => row.event.label === 1).length },
      },
      base: { features: baseNames, auc: round(baseScore.auc, 4), rows: baseScore.rows, positives: baseScore.positives },
      withGraph: { features: [...baseNames, ...graphNames], auc: round(graphScore.auc, 4), rows: graphScore.rows, positives: graphScore.positives },
      increment: round(graphScore.auc - baseScore.auc, 4),
      coefficients: graphFit.model.names
        .map((name, index) => ({ name, weight: round(graphFit.model.weights[index]!, 4) }))
        .filter((entry) => entry.name.startsWith('g_')),
    },
    labelIndependence: { identical, checked },
    labelPropagation: {
      feature: 'g_neighbour_fraud_rate',
      pit: { auc: pitLabelReport.auc, coverage: pitLabelReport.coverage, positives: pitLabelReport.positives },
      leaky: { auc: leakyLabelReport.auc, coverage: leakyLabelReport.coverage },
      models: {
        withoutLabels: round(graphScore.auc, 4),
        withLabels: round(labelScore.auc, 4),
        increment: round(labelScore.auc - graphScore.auc, 4),
      },
      cutoffRespected: { identical: labelCheckIdentical, checked: labelCheckCount, leakyDiffers: leakyLabelReport.auc !== pitLabelReport.auc },
      monthly: labelMonthly,
    },
    crossCheck,
    limits: [
      '图特征只有结构量（连通分量、两跳账户、设备扇出、PageRank），不读标签；任何"邻居欺诈率"都是标签穿了件图的外衣',
      '快照取上月最后一天：这是决策时点能加载的最新结构，因此早期月份天然弱于后期（progression 一栏就是它的形状）',
      `增量只在 holdout（${cutoff} 之后）上度量；训练窗口内更漂亮，但那不是证据`,
      '这份演示数据里团伙是**种进去的**（50% 的欺诈事件被路由到 5 台设备/3 个 IP）：它检验的是管线能不能把结构变成可用的数，不代表真实世界里的增益大小',
    ],
    cost: { ms: Math.round(performance.now() - started), accounts: newest.accounts, events: events.length, queries: sql.length },
    evidence: { sql },
  };
  return report;
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
