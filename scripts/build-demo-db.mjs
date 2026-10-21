#!/usr/bin/env node
/**
 * Builds the demo warehouse and its independent golden values.
 *
 * Two things matter here, and neither is the data itself:
 *
 * 1. **The seed is deterministic.** A fixed PRNG means the same numbers on every machine, so a report that
 *    says "spend = 12,345,678.90" is checkable by anyone who runs this script.
 * 2. **The goldens are computed from the rows, not from SQL.** They are summed in JavaScript from the exact
 *    values inserted, so the `golden` probe compares two independent paths to the same number. If the metric
 *    definition in the semantic layer drifts (forgets a refund, double counts a join), the probe fails - and
 *    it fails because the two computations disagree, not because a test file was updated to match a bug.
 *
 * The DDL is MySQL-flavoured on purpose (comments, inline indexes) and is rewritten for SQLite only at load
 * time, so the comments stay available to the DDL reader.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const fixtures = join(root, 'fixtures', 'demo');
const dbPath = join(fixtures, 'data', 'demo.db');

// --- deterministic PRNG (mulberry32), so the dataset is reproducible everywhere
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(20261020);
const round2 = (n) => Math.round(n * 100) / 100;
const between = (lo, hi) => lo + random() * (hi - lo);

const regions = [
  { id: 1, name: '华东', country: 'CN', scale: 1.35 },
  { id: 2, name: '华南', country: 'CN', scale: 1.1 },
  { id: 3, name: '华北', country: 'CN', scale: 1.0 },
  { id: 4, name: '西南', country: 'CN', scale: 0.7 },
];
const industries = [
  { id: 1, name: '母婴', sector: '快消', cpc: 1.5, cvr: 0.021, aov: 260 },
  { id: 2, name: '3C数码', sector: '数码', cpc: 3.2, cvr: 0.006, aov: 1450 },
  { id: 3, name: '美妆个护', sector: '美妆', cpc: 2.1, cvr: 0.016, aov: 320 },
];
const channels = [
  { id: 1, name: '搜索', type: '竞价', cvrFactor: 1.25, cpcFactor: 1.4 },
  { id: 2, name: '信息流', type: '竞价', cvrFactor: 0.8, cpcFactor: 0.85 },
  { id: 3, name: '直播', type: '内容', cvrFactor: 1.5, cpcFactor: 0.6 },
];
const campaigns = [
  { id: 1, name: '春季拉新', objective: '拉新' },
  { id: 2, name: '品类日促', objective: '复购' },
  { id: 3, name: '大促蓄水', objective: '拉新' },
  { id: 4, name: '清库存计划', objective: '清库存' },
  { id: 5, name: '品牌种草', objective: '拉新' },
];

const months = [];
for (const year of [2024, 2025]) {
  for (let month = 1; month <= 12; month++) months.push(`${year}-${String(month).padStart(2, '0')}`);
}
// 大促月份抬升：5 月与 11 月
const season = (month) => (month.endsWith('-05') ? 1.6 : month.endsWith('-11') ? 1.9 : month.endsWith('-12') ? 1.2 : 1.0);

const adRows = [];
for (const month of months) {
  const monthIndex = Number(month.slice(5, 7));
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), monthIndex, 0)).getUTCDate();
  for (const region of regions) {
    for (const industry of industries) {
      for (const channel of channels) {
        // One aggregated "day" row per month per cell keeps the dataset small but the ratios realistic.
        //
        // One property is designed into the data because the campaign agent depends on it: **diminishing
        // returns**. Conversions saturate as spend grows within a cell (`saturation = 1 / (1 + spend / K)`),
        // so revenue is concave in spend and the *marginal* ROI sits below the average one. In a linear world
        // every allocation would be equally good and "move budget here" would be unjustifiable.
        const budgetWave = 1 + 0.4 * Math.sin(monthIndex * 0.7 + region.id + industry.id * 1.3);
        const cell = region.scale * season(month) * budgetWave * between(0.9, 1.1);
        const clicks = Math.round(between(20_000, 45_000) * cell * (channel.name === '直播' ? 0.7 : 1));
        const cpc = industry.cpc * channel.cpcFactor * between(0.9, 1.1);
        const spend = round2(clicks * cpc);
        const impressions = Math.round(clicks * between(55, 90));
        const saturationBudget = 120_000 * region.scale;
        const saturation = 1 / (1 + spend / saturationBudget);
        const conversions = Math.round(clicks * industry.cvr * channel.cvrFactor * saturation * between(0.95, 1.05));
        const revenue = round2(conversions * industry.aov * between(0.95, 1.05) * (channel.name === '直播' ? 0.92 : 1));
        const newCustomers = Math.round(conversions * between(0.25, 0.45));
        adRows.push({
          date_key: `${month}-${String((daysInMonth / 2) | 0).padStart(2, '0')}`,
          region_id: region.id,
          industry_id: industry.id,
          channel_id: channel.id,
          campaign_id: 1 + ((region.id * 3 + industry.id * 5 + channel.id * 7 + monthIndex) % 5),
          impressions,
          clicks,
          spend,
          revenue,
          conversions,
          new_customers: newCustomers,
        });
      }
    }
  }
}

const orderRows = [];
let orderSeq = 1;
for (let i = 0; i < 2600; i++) {
  const region = regions[(random() * regions.length) | 0];
  const industry = industries[(random() * industries.length) | 0];
  const month = months[(random() * months.length) | 0];
  const day = 1 + ((random() * 28) | 0);
  const amount = round2(between(industry.aov * 0.5, industry.aov * 2.2));
  const roll = random();
  const status = roll < 0.82 ? 'paid' : roll < 0.92 ? 'refunded' : 'pending';
  const refund = status === 'refunded' ? amount : status === 'paid' && random() < 0.04 ? round2(amount * 0.25) : 0;
  orderRows.push({
    order_id: `SO${String(orderSeq++).padStart(6, '0')}`,
    order_date: `${month}-${String(day).padStart(2, '0')}`,
    region_id: region.id,
    industry_id: industry.id,
    amount,
    refund_amount: refund,
    status,
  });
}

// --- risk corpus: events, labels, feature snapshots, and two rules that are already live
//
// The shape matters more than the numbers:
//  - the label (`is_fraud`) is confirmed AFTER the event (`label_date`), which is what makes point-in-time
//    validation meaningful;
//  - features carry `as_of_date`, and one of them (`f_chargeback_30d`) is computed 30 days after the event and
//    nearly encodes the label - a future function the agent must reject;
//  - one region's fraud rate steps up at 2025-07, so the trend detector has a real changepoint to find.

const gaussian = () => {
  // Box-Muller; the seed is already fixed, so this stays reproducible
  const u = Math.max(random(), 1e-9);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const logistic = (z) => 1 / (1 + Math.exp(-z));

const riskEvents = [];
const featureRows = [];
let eventSeq = 1;
for (const month of months) {
  const eventsThisMonth = 600 + ((random() * 60) | 0);
  for (let index = 0; index < eventsThisMonth; index++) {
    const region = regions[(random() * regions.length) | 0];
    const channel = channels[(random() * channels.length) | 0];
    const day = 1 + ((random() * 28) | 0);
    const eventDate = `${month}-${String(day).padStart(2, '0')}`;
    const eventId = `RE${String(eventSeq++).padStart(7, '0')}`;

    // features: a few informative, a few noise
    const loginFail = Math.max(0, Math.round(1.2 + 1.6 * gaussian()));
    const newDevice = random() < 0.18 ? 1 : 0;
    const amount = round2(Math.exp(6.2 + 1.1 * gaussian()));
    const nightRatio = Math.min(1, Math.max(0, 0.2 + 0.18 * gaussian()));
    const accountAge = Math.max(1, Math.round(Math.exp(4.6 + 1.0 * gaussian())));
    const sharedDevice = Math.max(0, Math.round(0.6 + 1.1 * gaussian()));

    // the model score is a noisy function of the informative features: AUC around 0.75-0.85
    const signal = 1.1 * (loginFail - 1.2) + 2.2 * newDevice + 1.1 * (Math.log(amount) - 6.2)
      + 2.6 * (nightRatio - 0.2) - 0.8 * (Math.log(accountAge) - 4.6) + 0.7 * (sharedDevice - 0.6);
    const modelScore = Math.min(0.999, Math.max(0.001, logistic(signal * 0.85 - 2.6) + 0.03 * gaussian()));

    // fraud probability: the injected step in 华北 from 2025-07 is the trend the detector must find
    const step = region.id === 3 && month >= '2025-07' ? 1.35 : 0;
    const baseline = -6.2 + step + 0.8 * (loginFail - 1.2) + 1.5 * newDevice + 0.35 * (Math.log(amount) - 6.2)
      + 1.5 * (nightRatio - 0.2) - 0.5 * (Math.log(accountAge) - 4.6) + 3.4 * (modelScore - 0.3);
    const isFraud = random() < logistic(baseline) ? 1 : 0;
    const labelDate = `${month}-${String(Math.min(28, day + 7 + ((random() * 20) | 0))).padStart(2, '0')}`;

    riskEvents.push({
      event_id: eventId, event_date: eventDate, region_id: region.id, channel_id: channel.id,
      amount, is_fraud: isFraud, label_date: labelDate,
    });

    // A blacklist hit is the kind of high-precision, low-recall signal a real stack has: it is known *before*
    // the event (the device was already listed), and it is what makes a rule that clears a 0.75 precision gate
    // realistic. The model score carries the recall; the blacklist carries the precision; conjunctions buy both.
    const blacklistHit = isFraud === 1 ? (random() < 0.35 ? 1 : 0) : (random() < 0.003 ? 1 : 0);

    const features = {
      f_blacklist_hit: blacklistHit,
      f_login_fail_7d: loginFail,
      f_new_device_flag: newDevice,
      f_amount_7d: round2(amount * (1 + 0.2 * random())),
      f_night_txn_ratio: Math.round(nightRatio * 1000) / 1000,
      f_account_age_days: accountAge,
      f_device_shared_cnt: sharedDevice,
      model_score_v1: Math.round(modelScore * 10000) / 10000,
      // the future function: computed 30 days later and nearly equal to the label
      f_chargeback_30d: isFraud === 1 ? (random() < 0.92 ? 1 : 0) : (random() < 0.03 ? 1 : 0),
    };
    for (const [name, value] of Object.entries(features)) {
      featureRows.push({
        event_id: eventId,
        feature_name: name,
        as_of_date: name === 'f_chargeback_30d' ? addDays(eventDate, 30) : eventDate,
        value,
      });
    }
  }
}

const featureRegistry = [
  { feature_name: 'f_blacklist_hit', entity: 'device', window: 'snapshot', data_type: 'bool', owner: 'risk-ops', freshness_hours: 12, coverage: 1, available_before_event: 1 },
  { feature_name: 'f_login_fail_7d', entity: 'account', window: '7d', data_type: 'numeric', owner: 'risk-eng', freshness_hours: 24, coverage: 1, available_before_event: 1 },
  { feature_name: 'f_new_device_flag', entity: 'device', window: 'snapshot', data_type: 'bool', owner: 'risk-eng', freshness_hours: 24, coverage: 1, available_before_event: 1 },
  { feature_name: 'f_amount_7d', entity: 'account', window: '7d', data_type: 'numeric', owner: 'risk-eng', freshness_hours: 24, coverage: 1, available_before_event: 1 },
  { feature_name: 'f_night_txn_ratio', entity: 'account', window: '30d', data_type: 'numeric', owner: 'risk-eng', freshness_hours: 24, coverage: 1, available_before_event: 1 },
  { feature_name: 'f_account_age_days', entity: 'account', window: 'snapshot', data_type: 'numeric', owner: 'risk-eng', freshness_hours: 48, coverage: 1, available_before_event: 1 },
  { feature_name: 'f_device_shared_cnt', entity: 'device', window: '30d', data_type: 'numeric', owner: 'risk-eng', freshness_hours: 24, coverage: 1, available_before_event: 1 },
  { feature_name: 'model_score_v1', entity: 'account', window: 'snapshot', data_type: 'score', owner: 'risk-model', freshness_hours: 24, coverage: 1, available_before_event: 1 },
  { feature_name: 'f_chargeback_30d', entity: 'account', window: '30d', data_type: 'numeric', owner: 'risk-eng', freshness_hours: 720, coverage: 1, available_before_event: 0 },
];

const existingRules = [
  { rule_id: 'R001', expression: 'amount >= 5000 AND f_new_device_flag = 1', status: 'active', owner: 'risk-policy', deployed_at: '2024-06-01' },
  { rule_id: 'R002', expression: 'f_login_fail_7d >= 3', status: 'active', owner: 'risk-policy', deployed_at: '2024-09-15' },
];

function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// --- the goldens: summed in JavaScript from the rows that are about to be inserted
const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
const paid = orderRows.filter((row) => row.status === 'paid');
const goldens = {
  note: 'Computed from the seed rows in JavaScript (see scripts/build-demo-db.mjs), independent of any SQL or metric definition.',
  generatedAt: process.env.PAGENT_BUILD_TIME ?? new Date().toISOString(),
  rowCounts: { fact_ad_daily: adRows.length, fact_order: orderRows.length },
  metrics: {
    spend: round2(sum(adRows, (r) => r.spend)),
    revenue: round2(sum(adRows, (r) => r.revenue)),
    impressions: sum(adRows, (r) => r.impressions),
    clicks: sum(adRows, (r) => r.clicks),
    conversions: sum(adRows, (r) => r.conversions),
    new_customers: sum(adRows, (r) => r.new_customers),
    gmv: round2(sum(paid, (r) => r.amount - r.refund_amount)),
    paid_orders: paid.length,
  },
};
goldens.metrics.roi = Math.round((goldens.metrics.revenue / goldens.metrics.spend) * 1e6) / 1e6;
goldens.metrics.cpa = Math.round((goldens.metrics.spend / goldens.metrics.conversions) * 1e6) / 1e6;
goldens.metrics.conversion_rate = Math.round((goldens.metrics.conversions / goldens.metrics.clicks) * 1e8) / 1e8;

// --- the DDL, rewritten just enough for SQLite (comments and inline KEY/INDEX are not SQLite syntax).
// Every DDL file is read, base tables first and views after, so the load order is explicit.
const ddlFiles = readdirSync(join(fixtures, 'ddl'))
  .filter((name) => name.toLowerCase().endsWith('.sql'))
  .sort((a, b) => (a === 'warehouse.sql' ? -1 : b === 'warehouse.sql' ? 1 : a.localeCompare(b)));
const ddl = ddlFiles
  .map((name) => readFileSync(join(fixtures, 'ddl', name), 'utf8')
    .replace(/COMMENT\s+'(?:[^']|'')*'/gi, '')
    .replace(/,\s*(?:UNIQUE\s+)?(?:INDEX|KEY)\s+[^\n]*?\)/gi, '')
    // a removed trailing index leaves `...,\n)` behind, which SQLite rejects
    .replace(/,\s*\)/g, '\n)'))
  .join('\n');

if (existsSync(dbPath)) rmSync(dbPath);
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
// A build is one atomic load of a file nobody else is reading: durability knobs that make every INSERT an
// fsync turn 120k rows into minutes. The file is rewritten from scratch on each run anyway.
db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');
db.exec(ddl);
db.exec('BEGIN');

const insertMany = (sql, columns, rows) => {
  const statement = db.prepare(sql);
  for (const row of rows) statement.run(...columns.map((column) => row[column]));
};
insertMany('INSERT INTO dim_region (region_id, region_name, country) VALUES (?, ?, ?)',
  ['id', 'name', 'country'], regions);
insertMany('INSERT INTO dim_industry (industry_id, industry_name, sector) VALUES (?, ?, ?)',
  ['id', 'name', 'sector'], industries);
insertMany('INSERT INTO dim_channel (channel_id, channel_name, channel_type) VALUES (?, ?, ?)',
  ['id', 'name', 'type'], channels);
insertMany('INSERT INTO dim_campaign (campaign_id, campaign_name, objective) VALUES (?, ?, ?)',
  ['id', 'name', 'objective'], campaigns);
insertMany(
  `INSERT INTO fact_ad_daily
     (date_key, region_id, industry_id, channel_id, campaign_id, impressions, clicks, spend, revenue, conversions, new_customers)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ['date_key', 'region_id', 'industry_id', 'channel_id', 'campaign_id', 'impressions', 'clicks', 'spend', 'revenue', 'conversions', 'new_customers'],
  adRows,
);
insertMany(
  `INSERT INTO fact_order (order_id, order_date, region_id, industry_id, amount, refund_amount, status)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ['order_id', 'order_date', 'region_id', 'industry_id', 'amount', 'refund_amount', 'status'],
  orderRows,
);
insertMany('INSERT INTO risk_event (event_id, event_date, region_id, channel_id, amount, is_fraud, label_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ['event_id', 'event_date', 'region_id', 'channel_id', 'amount', 'is_fraud', 'label_date'], riskEvents);
insertMany('INSERT INTO feature_registry (feature_name, entity, window, data_type, owner, freshness_hours, coverage, available_before_event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ['feature_name', 'entity', 'window', 'data_type', 'owner', 'freshness_hours', 'coverage', 'available_before_event'], featureRegistry);
insertMany('INSERT INTO feature_snapshot (event_id, feature_name, as_of_date, value) VALUES (?, ?, ?, ?)',
  ['event_id', 'feature_name', 'as_of_date', 'value'], featureRows);
insertMany('INSERT INTO risk_rule (rule_id, expression, status, owner, deployed_at) VALUES (?, ?, ?, ?, ?)',
  ['rule_id', 'expression', 'status', 'owner', 'deployed_at'], existingRules);

db.exec('COMMIT');

// The indexes the DDL declares, created after the load (SQLite keeps them out of CREATE TABLE). M3's
// performance checks read these from the catalog, so they have to exist for real.
for (const statement of [
  'CREATE INDEX idx_fact_ad_daily_date ON fact_ad_daily(date_key)',
  'CREATE INDEX idx_fact_ad_daily_region ON fact_ad_daily(region_id)',
  'CREATE INDEX idx_fact_order_date ON fact_order(order_date)',
  'CREATE INDEX idx_fact_order_status ON fact_order(status)',
  'CREATE INDEX idx_risk_event_date ON risk_event(event_date)',
  'CREATE INDEX idx_risk_event_region ON risk_event(region_id)',
  'CREATE INDEX idx_feature_snapshot_event ON feature_snapshot(event_id)',
]) {
  db.exec(statement);
}
db.close();

writeFileSync(join(fixtures, 'goldens.json'), `${JSON.stringify(goldens, null, 2)}\n`, 'utf8');
console.log(`wrote ${dbPath} (${adRows.length} ad rows, ${orderRows.length} orders, ${riskEvents.length} risk events, ${featureRows.length} feature rows)`);
console.log(`goldens: spend=${goldens.metrics.spend} revenue=${goldens.metrics.revenue} gmv=${goldens.metrics.gmv} roi=${goldens.metrics.roi}`);
