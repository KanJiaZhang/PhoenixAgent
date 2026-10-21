/**
 * The two numbers the gate is allowed to look at, plus what is still missing.
 *
 * **Accuracy** is computed only over what was probed, per class: an entity or relation nobody checked is not
 * "accurate", it is unmeasured, and the report says so with `accuracy: null` and an `under-sampled` note.
 * Averaging measured and unmeasured claims into one 0.97 is the kind of number that survives a review and
 * deserves to be distrusted.
 *
 * **Coverage** is about the warehouse, not about the candidates: how many of the catalog's tables and
 * columns the model actually has, how many columns carry a description a person can read, how many metrics
 * have a definition that points at real columns, and how many join pairs the model both declares and
 * validates.
 *
 * And then three things that make coverage actionable instead of decorative: **per-table completeness**
 * (because 84% documented hides a table at 20%), **orphans** (tables nothing refers to and no metric uses),
 * and the **relation inventory** (does the ontology cover the relations the business asked for, or only the
 * two we happened to extract?). A model that scores 100% on coverage with fourteen orphan tables is not
 * covered, it is just complete-looking.
 */

import type { Catalog } from '../../dataplane/src/sqlite.ts';
import type { TableProfile } from '../../dataplane/src/profile.ts';
import { tableId, type ProbeResult, type QualityReport, type Tally } from '../../contracts/src/index.ts';
import type { Conflict, MergedCandidate } from './merge.ts';

export interface EvaluateInput {
  graph: string;
  modelVersion: number;
  generatedAt: string;
  candidates: MergedCandidate[];
  probes: ProbeResult[];
  conflicts: Conflict[];
  catalog: Catalog;
  profiles?: TableProfile[];
  sourceFiles: { kind: string; path: string }[];
  unread?: { kind: string; path: string; reason: string }[];
  notes: string[];
  coverageFloors?: { columnsDocumented?: number; metricsDefined?: number };
}

const DEFAULT_FLOORS = { columnsDocumented: 0.8, metricsDefined: 0.9 };

const ENTITY_TYPES = ['table', 'column', 'metric', 'dimension', 'query', 'domain'] as const;
const RELATION_TYPES = [
  'contains', 'partOf', 'references', 'groupedBy', 'computedFrom', 'usesColumn', 'dimensionColumn',
  'definedBy', 'contributesTo', 'governedBy', 'synonymOf', 'belongsTo', 'hasMetric', 'hierarchy',
  'derivedFrom', 'writes',
] as const;

export function evaluate(input: EvaluateInput): QualityReport {
  const floors = { ...DEFAULT_FLOORS, ...input.coverageFloors };
  const live = input.candidates.filter((candidate) => candidate.status !== 'rejected');
  const probesByTarget = new Map<string, ProbeResult[]>();
  for (const probe of input.probes) {
    const list = probesByTarget.get(probe.target) ?? [];
    list.push(probe);
    probesByTarget.set(probe.target, list);
  }

  // --- accuracy per entity type
  const entities: Record<string, Tally> = {};
  for (const type of ENTITY_TYPES) {
    entities[type] = tally(live.filter((candidate) => candidate.kind === 'entity' && candidate.entityType === type), probesByTarget);
  }

  // --- accuracy per relation type
  const relations: Record<string, Tally> = {};
  for (const type of RELATION_TYPES) {
    relations[type] = tally(live.filter((candidate) => candidate.kind === 'relation' && candidate.relationType === type), probesByTarget);
  }

  const relationInventory: Record<string, number> = {};
  for (const candidate of live) {
    if (candidate.kind !== 'relation') continue;
    const type = candidate.relationType ?? 'unknown';
    relationInventory[type] = (relationInventory[type] ?? 0) + 1;
  }

  // --- coverage against the catalog
  const catalogTables = input.catalog.tables;
  const catalogColumns = catalogTables.flatMap((table) => table.columns.map((column) => `${table.name}.${column.name}`));
  const modelTables = new Set(
    live.filter((c) => c.entityType === 'table').map((c) => (c.payload as { name: string }).name),
  );
  const modelColumnKeys = new Set(
    live.filter((c) => c.entityType === 'column')
      .map((c) => {
        const payload = c.payload as { table: string; name: string };
        return `${payload.table}.${payload.name}`;
      })
      .filter((key) => catalogColumns.includes(key)),
  );
  const documentedColumns = live.filter((c) => c.entityType === 'column' && descriptionOf(c).length > 0).length;
  const metrics = live.filter((c) => c.entityType === 'metric');
  const metricsDefined = metrics.filter((c) => {
    const payload = c.payload as { expression?: string; tables?: string[] };
    return (payload.expression ?? '').length > 0 && (payload.tables ?? []).length > 0;
  }).length;
  const dimensions = live.filter((c) => c.entityType === 'dimension');
  const dimensionsBound = dimensions.filter((c) => (c.payload as { column?: string }).column).length;

  const joinPairs = new Set<string>();
  const validatedPairs = new Set<string>();
  for (const candidate of live.filter((c) => c.relationType === 'references')) {
    const from = (candidate.from ?? '').replace(/^column\//, '').split('.')[0] ?? '';
    const to = (candidate.to ?? '').replace(/^column\//, '').split('.')[0] ?? '';
    if (!from || !to) continue;
    const pair = [from, to].sort().join('|');
    joinPairs.add(pair);
    if ((probesByTarget.get(candidate.id) ?? []).some((probe) => probe.status === 'pass')) validatedPairs.add(pair);
  }

  const coverage = {
    tables: ratio(modelTables.size, catalogTables.length),
    columns: ratio(modelColumnKeys.size, catalogColumns.length),
    columnsDocumented: ratio(documentedColumns, modelColumnKeys.size),
    metricsWithDefinition: ratio(metricsDefined, metrics.length),
    dimensions: ratio(dimensionsBound, dimensions.length),
    joinPairs: joinPairs.size,
    joinPairsValidated: validatedPairs.size,
  };

  // --- completeness per table, and the tables nothing uses
  const connectedTables = new Set<string>();
  for (const candidate of live.filter((c) => c.relationType === 'references')) {
    connectedTables.add((candidate.from ?? '').replace(/^column\//, '').split('.')[0] ?? '');
    connectedTables.add((candidate.to ?? '').replace(/^column\//, '').split('.')[0] ?? '');
  }
  const completeness: QualityReport['completeness'] = [];
  const orphans: string[] = [];
  for (const table of catalogTables) {
    const columns = live.filter((c) => c.entityType === 'column'
      && (c.payload as { table?: string }).table === table.name);
    const documented = columns.filter((c) => descriptionOf(c).length > 0).length;
    const documentedRatio = columns.length === 0 ? 0 : round(documented / columns.length);
    const grainProbes = probesByTarget.get(tableId(table.name)) ?? [];
    const keyed = table.primaryKey.length > 0 && grainProbes.some((probe) => probe.status === 'pass');
    const connected = connectedTables.has(table.name);
    const measured = metrics.some((metric) => ((metric.payload as { tables?: string[] }).tables ?? []).includes(table.name));
    const score = round(documentedRatio * 0.4 + (keyed ? 0.2 : 0) + (connected ? 0.2 : 0) + (measured ? 0.2 : 0));

    const missing: string[] = [];
    if (documentedRatio < 1) missing.push(`${columns.length - documented} of ${columns.length} columns have no description`);
    if (!keyed) missing.push(table.primaryKey.length === 0 ? 'no primary key: the grain is unproven' : 'the declared key is not unique in the data');
    if (!connected) missing.push('no join relation: nothing can be sliced onto it');
    if (!measured) missing.push('no metric is defined on it');

    completeness.push({ table: table.name, score, missing });
    if (missing.length === 4) orphans.push(table.name);
  }
  completeness.sort((a, b) => a.score - b.score || a.table.localeCompare(b.table));

  // --- the gate
  const reasons: string[] = [];
  for (const probe of input.probes) {
    if (probe.status === 'fail') reasons.push(`${probe.id} failed: ${probe.detail}`);
  }
  for (const conflict of input.conflicts) {
    reasons.push(`${conflict.kind} conflict on ${conflict.target}: a person has to choose a definition`);
  }
  if (coverage.columnsDocumented < floors.columnsDocumented) {
    reasons.push(`only ${(coverage.columnsDocumented * 100).toFixed(1)}% of modelled columns have a description`
      + ` (floor ${(floors.columnsDocumented * 100).toFixed(0)}%)`);
  }
  if (coverage.metricsWithDefinition < floors.metricsDefined) {
    reasons.push(`only ${(coverage.metricsWithDefinition * 100).toFixed(1)}% of metrics have an executable definition`
      + ` (floor ${(floors.metricsDefined * 100).toFixed(0)}%)`);
  }
  for (const [type, entry] of Object.entries({ ...prefix('entity', entities), ...prefix('relation', relations) })) {
    if (entry.probed > 0 && entry.probed / Math.max(entry.total, 1) >= 0.8 && entry.accuracy !== null && entry.accuracy < 0.95) {
      reasons.push(`${type} accuracy is ${(entry.accuracy * 100).toFixed(1)}% over ${entry.probed} probes (floor 95%)`);
    }
  }

  const notes = [...input.notes];
  for (const [type, entry] of Object.entries(prefix('entity', entities))) {
    if (entry.total > 0 && entry.probed / entry.total < 0.8) {
      notes.push(`${type} is under-sampled: ${entry.probed}/${entry.total} could be probed, so accuracy is not reported`);
    }
  }
  for (const [type, entry] of Object.entries(prefix('relation', relations))) {
    if (entry.total > 0 && entry.probed / entry.total < 0.8) {
      notes.push(`${type} is under-sampled: ${entry.probed}/${entry.total} could be probed, so accuracy is not reported`);
    }
  }
  for (const file of input.unread ?? []) {
    notes.push(`${file.path} was not read: ${file.reason}`);
  }
  if (orphans.length > 0) {
    notes.push(`${orphans.length} table(s) are orphans (no key, no join, no metric): ${orphans.join(', ')}`);
  }
  for (const entry of completeness) {
    if (entry.score < 0.5) notes.push(`${entry.table} is ${(entry.score * 100).toFixed(0)}% complete: ${entry.missing.join('; ')}`);
  }

  return {
    graph: input.graph,
    modelVersion: input.modelVersion,
    generatedAt: input.generatedAt,
    sourceFiles: input.sourceFiles,
    entities,
    relations,
    coverage,
    completeness,
    relationInventory,
    orphans,
    gate: { passed: reasons.length === 0, reasons },
    probes: input.probes,
    conflicts: input.conflicts.map((conflict) => conflict.message),
    notes,
  };
}

function tally(candidates: MergedCandidate[], probesByTarget: Map<string, ProbeResult[]>): Tally {
  let probed = 0;
  let passed = 0;
  let weak = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const probes = (probesByTarget.get(candidate.id) ?? []).filter((probe) => probe.status !== 'skipped');
    if (probes.length === 0) continue;
    probed++;
    if (probes.some((probe) => probe.status === 'fail')) failed++;
    else if (probes.some((probe) => probe.status === 'weak' || probe.status === 'error')) weak++;
    else passed++;
  }
  const measured = passed + weak + failed;
  return {
    total: candidates.length,
    probed,
    passed,
    weak,
    failed,
    accuracy: measured === 0 ? null : Math.round((passed / measured) * 1e4) / 1e4,
  };
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1e4) / 1e4;
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function prefix(prefix: string, tallies: Record<string, Tally>): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  for (const [key, value] of Object.entries(tallies)) {
    if (value.total > 0) out[`${prefix}:${key}`] = value;
  }
  return out;
}

function descriptionOf(candidate: MergedCandidate): string {
  const description = (candidate.payload as { description?: string }).description;
  return typeof description === 'string' ? description : '';
}
