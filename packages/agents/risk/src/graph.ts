/**
 * Graph features: does the entity network around an account change the odds, and can we tell that *before* the event?
 *
 * Up to M8 the risk agent only ever saw rows: amount, channel, and a handful of snapshots. `account_id`,
 * `device_id` and `ip_id` existed in the fixture but nothing read them, so "PhoenixGraph is in the loop" was a
 * claim without a number behind it. This module turns that claim into three checkable things:
 *
 * | what | how it is checked |
 * | --- | --- |
 * | the graph carries signal | AUC of a structural feature, and AUC of a model with vs without the graph block |
 * | it is legal to use | every snapshot is built from edges strictly before the event month (`as_of <= event_date`) |
 * | two engines agree | a sample of accounts is traversed by the base and compared with the local BFS |
 *
 * The features are **structural only**: component size, two-hop accounts, device degree, shared-device fan-out and
 * PageRank. None of them reads `is_fraud`. A feature that counts "fraudulent neighbours" is the label wearing a
 * graph costume: it passes every AUC test and is unusable at decision time, when the neighbour's label does not
 * exist yet. `verify:p1graph` proves the point mechanically - it recomputes the features with shuffled labels and
 * asserts they are identical.
 *
 * Point-in-time is the subtle part. A snapshot "as of the end of the previous month" is what an analyst could
 * actually have loaded. The ring in this fixture forms over months, so the same account looks innocent in 2024-02
 * and suspicious in 2025-08. That progression is the design working, not a leak: the graph is catching up with
 * reality one month at a time, never ahead of it.
 */

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphClient } from '../../../core/src/graph-client.ts';

export interface EntityLink {
  eventId: string;
  date: string;
  account: string;
  device: string;
  ip: string;
}

export interface GraphAccountFeatures {
  account: string;
  /** Accounts in the same connected component (account--device--ip), including this one. */
  componentSize: number;
  /** Distinct *other* accounts reachable within two hops (a shared device or a shared IP). */
  twoHopAccounts: number;
  /** How many distinct devices this account used. */
  deviceDegree: number;
  /** The largest number of accounts sharing any one device this account used (1 = nobody else). */
  sharedDeviceMax: number;
  /** PageRank over the account--device--ip graph, scaled by 1000 so it reads like a score. */
  pagerank: number;
}

export interface GraphSnapshot {
  /** Last day the snapshot is allowed to know about (`YYYY-MM-DD`); one day before the month it serves. */
  asOf: string;
  /** Which month the snapshot is used for (`YYYY-MM`). */
  serves: string;
  accounts: number;
  devices: number;
  ips: number;
  edges: number;
  features: Map<string, GraphAccountFeatures>;
  /** account -> accounts sharing a device or an IP (the same two-hop definition as `twoHopAccounts`). */
  neighbours: Map<string, Set<string>>;
  /** The subset of links the snapshot actually used; the publisher writes exactly these. */
  links: EntityLink[];
}

export type SnapshotGrain = 'month' | 'week';

/** The last day of the month before `date`: the newest information a decision on `date` may use. */
export function snapshotCutoff(date: string): string {
  const [year, month] = date.slice(0, 7).split('-').map(Number) as [number, number];
  const previous = new Date(Date.UTC(year, month - 1, 0)); // day 0 of this month = last day of the previous one
  return previous.toISOString().slice(0, 10);
}

/** ISO-8601 week: Monday-based, week 1 is the week holding the first Thursday. */
export function isoWeek(date: string): { year: number; week: number; key: string; start: string } {
  const [year, month, day] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, day));
  const offset = (at.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(at);
  monday.setUTCDate(at.getUTCDate() - offset);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const weekYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: weekYear, week, key: `${weekYear}-W${String(week).padStart(2, '0')}`, start: monday.toISOString().slice(0, 10) };
}

/**
 * The period a decision on `date` may use, at the requested grain.
 *
 * Monthly is the default because a month of structure is what the audit trail is written against. Weekly is the finer
 * option: the same snapshot rule ("end before the period begins"), four times the snapshots, and a fresher graph for
 * accounts that appear mid-month. Both are point-in-time by construction; neither is "the latest data", which is the
 * mistake this whole module is built to avoid.
 */
export function periodOf(date: string, grain: SnapshotGrain): { key: string; asOf: string } {
  if (grain === 'month') {
    const month = date.slice(0, 7);
    return { key: month, asOf: snapshotCutoff(`${month}-01`) };
  }
  const week = isoWeek(date);
  const start = new Date(`${week.start}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 1); // the day before the week starts
  return { key: week.key, asOf: start.toISOString().slice(0, 10) };
}

interface Accumulated {
  accountDevices: Map<string, Set<string>>;
  accountIps: Map<string, Set<string>>;
  deviceAccounts: Map<string, Set<string>>;
  ipAccounts: Map<string, Set<string>>;
  used: EntityLink[];
}

function emptyAccumulated(): Accumulated {
  return { accountDevices: new Map(), accountIps: new Map(), deviceAccounts: new Map(), ipAccounts: new Map(), used: [] };
}

/** Adds one link. Monotone: nothing is ever removed, which is what lets a series walk the dates once. */
function accumulate(target: Accumulated, link: EntityLink): void {
  target.used.push(link);
  addTo(target.accountDevices, link.account, link.device);
  addTo(target.accountIps, link.account, link.ip);
  addTo(target.deviceAccounts, link.device, link.account);
  addTo(target.ipAccounts, link.ip, link.account);
}

/** Builds one snapshot from the links known by `asOf` (inclusive). */
export function buildSnapshot(links: EntityLink[], asOf: string, serves: string): GraphSnapshot {
  const accumulated = emptyAccumulated();
  for (const link of links) {
    if (link.date > asOf) continue;
    accumulate(accumulated, link);
  }
  return snapshotFromState(accumulated, asOf, serves);
}

/** The snapshot itself, from an already-accumulated state. Pure: it reads the state and never mutates it. */
function snapshotFromState(accumulated: Accumulated, asOf: string, serves: string): GraphSnapshot {
  const { accountDevices, accountIps, deviceAccounts, ipAccounts, used } = accumulated;

  // connected components over the three node types, sized in accounts
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (left: string, right: string): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };
  for (const account of accountDevices.keys()) parent.set(account, account);
  for (const [account, devices] of accountDevices) {
    for (const device of devices) {
      if (!parent.has(`d:${device}`)) parent.set(`d:${device}`, `d:${device}`);
      union(account, `d:${device}`);
    }
  }
  for (const [account, ips] of accountIps) {
    for (const ip of ips) {
      if (!parent.has(`i:${ip}`)) parent.set(`i:${ip}`, `i:${ip}`);
      union(account, `i:${ip}`);
    }
  }
  const componentAccounts = new Map<string, number>();
  for (const account of accountDevices.keys()) {
    const root = find(account);
    componentAccounts.set(root, (componentAccounts.get(root) ?? 0) + 1);
  }

  const pagerank = pagerankOf(accountDevices, deviceAccounts, accountIps, ipAccounts);

  const features = new Map<string, GraphAccountFeatures>();
  const neighboursOf = new Map<string, Set<string>>();
  for (const [account, devices] of accountDevices) {
    const neighbours = new Set<string>();
    let sharedDeviceMax = 1;
    for (const device of devices) {
      const peers = deviceAccounts.get(device)!;
      sharedDeviceMax = Math.max(sharedDeviceMax, peers.size);
      for (const peer of peers) if (peer !== account) neighbours.add(peer);
    }
    for (const ip of accountIps.get(account) ?? []) {
      for (const peer of ipAccounts.get(ip)!) if (peer !== account) neighbours.add(peer);
    }
    neighboursOf.set(account, neighbours);
    features.set(account, {
      account,
      componentSize: componentAccounts.get(find(account)) ?? 1,
      twoHopAccounts: neighbours.size,
      deviceDegree: devices.size,
      sharedDeviceMax,
      pagerank: Math.round((pagerank.get(account) ?? 0) * 1e6) / 1e3,
    });
  }

  return {
    asOf,
    serves,
    accounts: accountDevices.size,
    devices: deviceAccounts.size,
    ips: ipAccounts.size,
    edges: used.length,
    features,
    neighbours: neighboursOf,
    links: used,
  };
}

/**
 * One snapshot per period in the data, each built only from links dated before that period begins.
 *
 * The map is keyed by the period label (`2024-03` or `2024-W10`), so a lookup is exactly "which snapshot was this
 * event entitled to".
 */
export function buildSnapshots(links: EntityLink[], grain: SnapshotGrain = 'month'): Map<string, GraphSnapshot> {
  const cutoffs = new Map<string, { key: string; asOf: string }>();
  for (const link of links) {
    const period = periodOf(link.date, grain);
    cutoffs.set(period.key, period);
  }
  const ordered = [...cutoffs.values()].sort((left, right) => left.key.localeCompare(right.key));
  // One pass over the links instead of one pass per period: the state only grows, so a period's snapshot is
  // "everything applied so far". The per-snapshot work (components, features, PageRank) is unchanged - that is the
  // part that has to look at the whole graph anyway.
  const sorted = [...links].sort((left, right) => left.date.localeCompare(right.date));
  const accumulated = emptyAccumulated();
  let cursor = 0;
  const snapshots = new Map<string, GraphSnapshot>();
  for (const { key, asOf } of ordered) {
    while (cursor < sorted.length && sorted[cursor]!.date <= asOf) accumulate(accumulated, sorted[cursor++]!);
    snapshots.set(key, snapshotFromState(accumulated, asOf, key));
  }
  return snapshots;
}

/**
 * PageRank over the bipartite account--device--ip graph, damped, with a fixed iteration count.
 *
 * Twenty iterations at damping 0.85 converge well below 1e-6 on a graph this size, and a fixed count keeps the
 * result deterministic: a threshold loop would stop at a different place depending on float noise.
 */
function pagerankOf(
  accountDevices: Map<string, Set<string>>,
  deviceAccounts: Map<string, Set<string>>,
  accountIps: Map<string, Set<string>>,
  ipAccounts: Map<string, Set<string>>,
  iterations = 20,
  damping = 0.85,
): Map<string, number> {
  const accounts = [...accountDevices.keys()];
  const deviceIds = [...deviceAccounts.keys()];
  const ipIds = [...ipAccounts.keys()];
  const nodeCount = accounts.length + deviceIds.length + ipIds.length;
  if (nodeCount === 0) return new Map();

  // Indices instead of string keys, and a compressed adjacency instead of Map-of-Sets: PageRank touches every edge
  // twenty times per snapshot, so the representation is the cost. Same 20 iterations, same damping, same answer.
  const index = new Map<string, number>();
  for (const [offset, account] of accounts.entries()) index.set(account, offset);
  for (const [offset, device] of deviceIds.entries()) index.set(`d:${device}`, accounts.length + offset);
  for (const [offset, ip] of ipIds.entries()) index.set(`i:${ip}`, accounts.length + deviceIds.length + offset);

  const offsets = new Int32Array(nodeCount + 1);
  const targets: number[] = [];
  const push = (from: number, to: number) => {
    targets.push(to);
    offsets[from + 1] = offsets[from + 1]! + 1;
  };
  for (const [offset, account] of accounts.entries()) {
    for (const device of accountDevices.get(account) ?? []) push(offset, index.get(`d:${device}`)!);
    for (const ip of accountIps.get(account) ?? []) push(offset, index.get(`i:${ip}`)!);
  }
  for (const [offset, device] of deviceIds.entries()) {
    for (const account of deviceAccounts.get(device) ?? []) push(accounts.length + offset, index.get(account)!);
  }
  for (const [offset, ip] of ipIds.entries()) {
    for (const account of ipAccounts.get(ip) ?? []) push(accounts.length + deviceIds.length + offset, index.get(account)!);
  }
  for (let node = 0; node < nodeCount; node++) offsets[node + 1]! += offsets[node]!;
  const edgeTargets = Int32Array.from(targets);

  const base = (1 - damping) / nodeCount;
  let rank = new Float64Array(nodeCount).fill(1 / nodeCount);
  let next = new Float64Array(nodeCount);
  for (let step = 0; step < iterations; step++) {
    next.fill(base);
    for (let node = 0; node < nodeCount; node++) {
      const from = offsets[node]!;
      const to = offsets[node + 1]!;
      if (to === from) continue;
      const share = (damping * rank[node]!) / (to - from);
      for (let edge = from; edge < to; edge++) next[edgeTargets[edge]!]! += share;
    }
    const swap = rank;
    rank = next;
    next = swap;
  }

  const out = new Map<string, number>();
  for (const [offset, account] of accounts.entries()) out.set(account, rank[offset]!);
  return out;
}

export interface ConfirmedLabels {
  /** account -> the date its first fraud was *confirmed* (label_date, not event_date). */
  firstFraud: Map<string, string>;
}

/**
 * Neighbour reputation, from labels that exist at the cutoff and not one day later.
 *
 * This is the feature everybody reaches for first, and the one that is easiest to make useless: a neighbour's label is
 * only known on `label_date`, which is days or weeks *after* the neighbour's event. A feature that counts "fraudulent
 * neighbours" from the final label table is a future function wearing a graph costume - it scores beautifully and
 * cannot be computed at decision time.
 *
 * So the input here is not the label table, it is "labels confirmed on or before asOf", and the caller is expected to
 * build that set from `label_date`. `verify:p1graph` checks the difference by computing the same feature from all
 * labels and showing that the leaky version is the better one - which is exactly why it is not the one we use.
 */
export function confirmedLabelsByAccount(labels: { account: string; labelDate: string; label: 0 | 1 }[], asOf: string): ConfirmedLabels {
  const firstFraud = new Map<string, string>();
  for (const entry of labels) {
    if (entry.label !== 1) continue;
    if (entry.labelDate > asOf) continue;
    const existing = firstFraud.get(entry.account);
    if (!existing || entry.labelDate < existing) firstFraud.set(entry.account, entry.labelDate);
  }
  return { firstFraud };
}

export interface NeighbourLabels {
  /** Share of this account's neighbours whose fraud was confirmed by the cutoff (0 when it has none). */
  rate: number;
  /** Neighbours with a confirmed fraud, and neighbours in total. */
  frauds: number;
  neighbours: number;
}

/** The feature for one account against one snapshot and one label set. O(degree), not O(graph). */
export function neighbourLabelStats(snapshot: GraphSnapshot, account: string, confirmed: ConfirmedLabels): NeighbourLabels {
  const neighbours = snapshot.neighbours.get(account);
  if (!neighbours || neighbours.size === 0) return { rate: 0, frauds: 0, neighbours: 0 };
  let frauds = 0;
  for (const other of neighbours) if (confirmed.firstFraud.has(other)) frauds++;
  return { rate: frauds / neighbours.size, frauds, neighbours: neighbours.size };
}

/** The feature block for one event, from the snapshot of its own month (as of the previous month end). */
export function featuresAt(snapshots: Map<string, GraphSnapshot>, month: string, account: string): GraphAccountFeatures | null {
  return snapshots.get(month)?.features.get(account) ?? null;
}

export const GRAPH_FEATURES = ['g_component_size', 'g_two_hop_accounts', 'g_device_degree', 'g_shared_device_max', 'g_pagerank'] as const;
export type GraphFeatureName = (typeof GRAPH_FEATURES)[number];

export function featureValue(features: GraphAccountFeatures, name: GraphFeatureName): number {
  switch (name) {
    case 'g_component_size': return features.componentSize;
    case 'g_two_hop_accounts': return features.twoHopAccounts;
    case 'g_device_degree': return features.deviceDegree;
    case 'g_shared_device_max': return features.sharedDeviceMax;
    case 'g_pagerank': return features.pagerank;
  }
}

/** Vertices and edges for the base, built from the snapshot's own links so the two views cannot drift apart. */
export function payloadFromLinks(snapshot: GraphSnapshot) {
  const vertices = new Map<string, { id: string; vertexSchemaName: string; properties: { index: number; value: unknown }[] }>();
  const edges: { edgeId: string; edgeSchemaName: string; source: string; destination: string; properties: { index: number; value: unknown }[] }[] = [];
  const seen = new Set<string>();
  for (const link of snapshot.links) {
    vertices.set(`a:${link.account}`, { id: link.account, vertexSchemaName: 'Account', properties: [{ index: 0, value: link.account }] });
    vertices.set(`d:${link.device}`, { id: link.device, vertexSchemaName: 'Device', properties: [{ index: 0, value: link.device }] });
    vertices.set(`i:${link.ip}`, { id: link.ip, vertexSchemaName: 'Ip', properties: [{ index: 0, value: link.ip }] });
    for (const edge of [
      { edgeId: `${link.account}->UsesDevice->${link.device}`, edgeSchemaName: 'UsesDevice', source: link.account, destination: link.device, properties: [] },
      { edgeId: `${link.account}->UsedIp->${link.ip}`, edgeSchemaName: 'UsedIp', source: link.account, destination: link.ip, properties: [] },
    ]) {
      if (seen.has(edge.edgeId)) continue;
      seen.add(edge.edgeId);
      edges.push(edge);
    }
  }
  return { vertices: [...vertices.values()], edges };
}

export interface CrossCheck {
  status: 'ok' | 'skipped' | 'failed';
  graph: string;
  sampled: number;
  agree: number;
  /** What the base answered minus what the local BFS answered, for the mismatching sample. */
  mismatches: { account: string; base: number; local: number }[];
  note?: string;
}

/**
 * Publishes the newest snapshot to the base and compares its traversal with the local BFS.
 *
 * Both engines are asked the same question - "how many *other* accounts share a device or an IP with this one" -
 * and the answers are compared on a deterministic sample. This is the graph analogue of the rule-to-SQL
 * cross-check in the risk audit: one implementation proves the number, two prove the *definition*.
 */
export async function publishAndCrossCheck(client: GraphClient, snapshot: GraphSnapshot, options: {
  graph?: string;
  sample?: number;
} = {}): Promise<CrossCheck> {
  const graph = options.graph ?? 'pag-risk-graph';
  const sampleSize = options.sample ?? 60;
  const accounts = [...snapshot.features.keys()].sort();
  if (accounts.length === 0) return { status: 'skipped', graph, sampled: 0, agree: 0, mismatches: [], note: 'the snapshot has no accounts' };

  const draft = {
    name: graph,
    description: 'PhoenixAgent risk entity graph: Account-[UsesDevice]->Device, Account-[UsedIp]->Ip. Written by verify:p1graph.',
    idType: 'string' as const,
    vertices: [
      { name: 'Account', description: 'one account', properties: [{ name: 'accountId', type: 'string', description: 'account id' }] },
      { name: 'Device', description: 'one device', properties: [{ name: 'deviceId', type: 'string', description: 'device id' }] },
      { name: 'Ip', description: 'one ip', properties: [{ name: 'ipId', type: 'string', description: 'ip id' }] },
    ],
    edges: [
      { name: 'UsesDevice', description: 'account used a device', direction: 'DIRECTED' as const, source: 'Account', target: 'Device', properties: [] },
      { name: 'UsedIp', description: 'account appeared on an ip', direction: 'DIRECTED' as const, source: 'Account', target: 'Ip', properties: [] },
    ],
  };

  try {
    await client.saveSchema(draft, true);
    await client.batchWrite(graph, payloadFromLinks(snapshot), 200);
  } catch (error) {
    return { status: 'failed', graph, sampled: 0, agree: 0, mismatches: [], note: `publish failed: ${(error as Error).message.slice(0, 300)}` };
  }

  const step = Math.max(1, Math.floor(accounts.length / sampleSize));
  const chosen = accounts.filter((_, index) => index % step === 0).slice(0, sampleSize);
  const mismatches: CrossCheck['mismatches'] = [];
  for (const account of chosen) {
    const local = snapshot.features.get(account)!.twoHopAccounts;
    let base: number;
    try {
      // the base answers by id + type (a keyed store cannot start from a whole type), and `dedup` turns
      // "one row per shared device and one per shared ip" into "one row per peer account"
      const rows = await client.query(graph,
        `g.V('${account}','Account').out('UsesDevice','UsedIp').in('UsesDevice','UsedIp').dedup()`);
      const peers = new Set<string>();
      for (const row of rows as unknown[]) {
        const id = String((row as { id?: unknown })?.id ?? row);
        if (id !== account) peers.add(id);
      }
      base = peers.size;
    } catch (error) {
      return { status: 'failed', graph, sampled: chosen.length, agree: mismatches.length, mismatches, note: `traversal failed: ${(error as Error).message.slice(0, 300)}` };
    }
    if (base !== local) mismatches.push({ account, base, local });
  }
  return {
    status: mismatches.length === 0 ? 'ok' : 'failed',
    graph,
    sampled: chosen.length,
    agree: chosen.length - mismatches.length,
    mismatches: mismatches.slice(0, 10),
  };
}

/**
 * Removes the schema file the base writes for a graph we created.
 *
 * The base persists a published schema next to its own sources; leaving `pag-*` files in its directory would be this
 * repository editing another one. The served graph disappears on the base's next restart; the file is the part we
 * can and should clean up.
 */
export function cleanupPublishedSchema(graph: string, baseDir = process.env.PAGENT_BASE_DIR ?? '../PhoenixGraph'): string[] {
  const removed: string[] = [];
  for (const name of [`${graph}.json`]) {
    const path = join(baseDir, name);
    try {
      unlinkSync(path);
      removed.push(path);
    } catch {
      // already gone: nothing to clean
    }
  }
  return removed;
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}
