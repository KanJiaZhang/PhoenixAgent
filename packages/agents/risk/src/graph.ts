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
  /** The subset of links the snapshot actually used; the publisher writes exactly these. */
  links: EntityLink[];
}

/** The last day of the month before `date`: the newest information a decision on `date` may use. */
export function snapshotCutoff(date: string): string {
  const [year, month] = date.slice(0, 7).split('-').map(Number) as [number, number];
  const previous = new Date(Date.UTC(year, month - 1, 0)); // day 0 of this month = last day of the previous one
  return previous.toISOString().slice(0, 10);
}

/** Builds one snapshot from the links known by `asOf` (inclusive). */
export function buildSnapshot(links: EntityLink[], asOf: string, serves: string): GraphSnapshot {
  const accountDevices = new Map<string, Set<string>>();
  const accountIps = new Map<string, Set<string>>();
  const deviceAccounts = new Map<string, Set<string>>();
  const ipAccounts = new Map<string, Set<string>>();
  const used: EntityLink[] = [];

  for (const link of links) {
    if (link.date > asOf) continue;
    used.push(link);
    addTo(accountDevices, link.account, link.device);
    addTo(accountIps, link.account, link.ip);
    addTo(deviceAccounts, link.device, link.account);
    addTo(ipAccounts, link.ip, link.account);
  }

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
    links: used,
  };
}

/** One snapshot per month in the data, each built only from links dated before that month. */
export function buildSnapshots(links: EntityLink[]): Map<string, GraphSnapshot> {
  const months = [...new Set(links.map((link) => link.date.slice(0, 7)))].sort();
  const snapshots = new Map<string, GraphSnapshot>();
  for (const month of months) {
    snapshots.set(month, buildSnapshot(links, snapshotCutoff(`${month}-01`), month));
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
  const nodeIds = [
    ...accounts,
    ...[...deviceAccounts.keys()].map((id) => `d:${id}`),
    ...[...ipAccounts.keys()].map((id) => `i:${id}`),
  ];
  if (nodeIds.length === 0) return new Map();
  const rank = new Map<string, number>(nodeIds.map((node) => [node, 1 / nodeIds.length]));
  const outgoing = (node: string): string[] => {
    if (node.startsWith('d:')) return [...(deviceAccounts.get(node.slice(2)) ?? [])];
    if (node.startsWith('i:')) return [...(ipAccounts.get(node.slice(2)) ?? [])];
    return [...(accountDevices.get(node) ?? [])].map((id) => `d:${id}`)
      .concat([...(accountIps.get(node) ?? [])].map((id) => `i:${id}`));
  };
  for (let step = 0; step < iterations; step++) {
    const next = new Map<string, number>(nodeIds.map((node) => [node, (1 - damping) / nodeIds.length]));
    for (const [node, value] of rank) {
      const targets = outgoing(node);
      if (targets.length === 0) continue;
      const share = (damping * value) / targets.length;
      for (const target of targets) next.set(target, (next.get(target) ?? 0) + share);
    }
    for (const [node, value] of next) rank.set(node, value);
  }
  const out = new Map<string, number>();
  for (const account of accounts) out.set(account, rank.get(account) ?? 0);
  return out;
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
