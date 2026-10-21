/**
 * Merging, and the only place a disagreement becomes visible instead of becoming a fact.
 *
 * The merge rules are boring on purpose: human beats parser beats catalog beats model, an empty field is
 * filled by a non-empty one, aliases are unioned, and a stronger source may overwrite a weaker one. What is
 * not boring is what happens next: every candidate keeps its **observations** - each source's version of the
 * expression, the type, the reference target - and those are compared. Two sources that disagree about what
 * GMV means do not get averaged, or silently resolved in favour of whichever file was read last. The metric
 * is marked `needs_review`, a conflict is recorded with both sides quoted, and the gate refuses to publish.
 *
 * The comparison needs one normalisation: table qualifiers are stripped before expressions are compared, so
 * `SUM(fact_order.amount - fact_order.refund_amount)` from an ETL file and `SUM(amount - refund_amount)` from
 * a wiki equal each other, while `SUM(amount)` does not. That is the whole difference between "the document
 * wrote it more briefly" and "the document defines a different metric".
 */

import type { Candidate, Provenance } from '../../contracts/src/index.ts';

export interface Observation {
  provenance: Provenance;
  sourceFile: string;
  expression?: string;
  dataType?: string;
  referenceTarget?: string;
  description?: string;
}

export interface MergedCandidate extends Candidate {
  observations: Observation[];
  /** Ids of the conflicts this candidate is part of. Empty when the sources agree. */
  conflictIds: string[];
}

export interface Conflict {
  id: string;
  kind: 'metric-expression' | 'column-type' | 'reference-target';
  target: string;
  message: string;
  values: { sourceFile: string; provenance: Provenance; value: string }[];
}

const RANK: Record<Provenance, number> = { human: 4, parser: 3, catalog: 2, llm: 1 };

export interface MergeResult {
  merged: MergedCandidate[];
  conflicts: Conflict[];
  notes: string[];
}

export function mergeCandidates(all: Candidate[]): MergeResult {
  const byId = new Map<string, MergedCandidate>();
  const notes: string[] = [];

  for (const candidate of all) {
    const existing = byId.get(candidate.id);
    if (!existing) {
      byId.set(candidate.id, {
        ...candidate,
        evidence: [...candidate.evidence],
        observations: [observe(candidate)],
        conflictIds: [],
      });
      continue;
    }
    existing.observations.push(observe(candidate));
    existing.confidence = Math.max(existing.confidence, candidate.confidence);
    existing.evidence = dedupeEvidence([...existing.evidence, ...candidate.evidence]);
    existing.status = existing.status === 'needs_review' || candidate.status === 'needs_review'
      ? 'needs_review'
      : existing.status;
    if (candidate.note && !existing.note) existing.note = candidate.note;
    existing.payload = mergePayload(existing.payload, candidate.payload, existing.provenance, candidate.provenance);
    if (RANK[candidate.provenance] > RANK[existing.provenance]) existing.provenance = candidate.provenance;
  }

  const conflicts: Conflict[] = [];
  for (const candidate of byId.values()) {
    const found = detectConflicts(candidate);
    for (const conflict of found) {
      conflicts.push(conflict);
      candidate.conflictIds.push(conflict.id);
      candidate.status = 'needs_review';
      candidate.note = conflict.message;
    }
  }

  if (conflicts.length > 0) {
    notes.push(`${conflicts.length} conflict(s) need a human decision; the gate will not pass while they are open`);
  }

  return { merged: [...byId.values()], conflicts, notes };
}

function observe(candidate: Candidate): Observation {
  const payload = candidate.payload as Record<string, unknown>;
  return {
    provenance: candidate.provenance,
    sourceFile: candidate.evidence[0]?.sourceFile ?? '(unknown)',
    expression: typeof payload.expression === 'string' && payload.expression.length > 0 ? payload.expression : undefined,
    dataType: typeof payload.dataType === 'string' && payload.dataType.length > 0 ? payload.dataType : undefined,
    referenceTarget: candidate.relationType === 'references' ? candidate.to : undefined,
    description: typeof payload.description === 'string' && payload.description.length > 0 ? payload.description : undefined,
  };
}

function mergePayload(
  existing: Candidate['payload'],
  incoming: Candidate['payload'],
  existingProvenance: Provenance,
  incomingProvenance: Provenance,
): Candidate['payload'] {
  const out = { ...(existing as Record<string, unknown>) };
  const source = incoming as Record<string, unknown>;
  const stronger = RANK[incomingProvenance] > RANK[existingProvenance];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (key === 'alias') {
      const merged = [...new Set([...(Array.isArray(out.alias) ? (out.alias as string[]) : []), ...(Array.isArray(value) ? (value as string[]) : [])])];
      if (merged.length > 0) out.alias = merged;
      continue;
    }
    const current = out[key];
    const empty = current === undefined || current === null || current === '' ||
      (Array.isArray(current) && current.length === 0);
    if (empty || stronger) out[key] = value;
  }
  return out as Candidate['payload'];
}

function detectConflicts(candidate: MergedCandidate): Conflict[] {
  if (candidate.kind === 'entity' && candidate.entityType === 'metric') {
    const expressions = new Map<string, Observation>();
    for (const observation of candidate.observations) {
      if (!observation.expression) continue;
      const key = normalizeExpression(observation.expression);
      if (!expressions.has(key)) expressions.set(key, observation);
    }
    if (expressions.size > 1) {
      const values = [...expressions.values()].map((observation) => ({
        sourceFile: observation.sourceFile,
        provenance: observation.provenance,
        value: observation.expression!,
      }));
      return [{
        id: `conflict/${candidate.id}/expression`,
        kind: 'metric-expression',
        target: candidate.id,
        message: `${candidate.id} 的口径有两个互不相等的定义：${values.map((v) => `${v.sourceFile} 说 ${v.value}`).join('；')}`,
        values,
      }];
    }
  }

  if (candidate.kind === 'entity' && candidate.entityType === 'column') {
    const types = new Map<string, Observation>();
    for (const observation of candidate.observations) {
      if (!observation.dataType) continue;
      const key = observation.dataType.toLowerCase().replace(/\s+/g, '');
      if (!types.has(key)) types.set(key, observation);
    }
    if (types.size > 1) {
      const values = [...types.values()].map((observation) => ({
        sourceFile: observation.sourceFile,
        provenance: observation.provenance,
        value: observation.dataType!,
      }));
      return [{
        id: `conflict/${candidate.id}/type`,
        kind: 'column-type',
        target: candidate.id,
        message: `${candidate.id} 的类型不一致：${values.map((v) => `${v.sourceFile} 说 ${v.value}`).join('；')}`,
        values,
      }];
    }
  }

  if (candidate.kind === 'relation' && candidate.relationType === 'references') {
    const targets = new Map<string, Observation>();
    for (const observation of candidate.observations) {
      if (!observation.referenceTarget) continue;
      if (!targets.has(observation.referenceTarget)) targets.set(observation.referenceTarget, observation);
    }
    if (targets.size > 1) {
      const values = [...targets.entries()].map(([target, observation]) => ({
        sourceFile: observation.sourceFile,
        provenance: observation.provenance,
        value: target,
      }));
      return [{
        id: `conflict/${candidate.from}/references`,
        kind: 'reference-target',
        target: candidate.from!,
        message: `${candidate.from} 被声明指向多个目标：${values.map((v) => `${v.sourceFile} 指向 ${v.value}`).join('；')}`,
        values,
      }];
    }
  }

  return [];
}

/**
 * `SUM(fact_order.amount - fact_order.refund_amount)` -> `sum(amount-refund_amount)`.
 *
 * Qualifiers are removed because different sources have different reasons to write them (an ETL file must,
 * a wiki need not). Whitespace and case are removed for the same reason. Nothing else is normalised: the
 * `-` in `amount - refund_amount` must survive, because that operator is the whole argument.
 */
export function normalizeExpression(expression: string): string {
  return expression
    .toLowerCase()
    .replace(/[`"]/g, '')
    .replace(/\b[a-z_][a-z0-9_$]*\./g, '')
    .replace(/\s+/g, '');
}

function dedupeEvidence(evidence: Candidate['evidence']): Candidate['evidence'] {
  const seen = new Set<string>();
  const out: Candidate['evidence'] = [];
  for (const item of evidence) {
    const key = `${item.sourceFile}|${item.span?.join('-') ?? ''}|${item.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
