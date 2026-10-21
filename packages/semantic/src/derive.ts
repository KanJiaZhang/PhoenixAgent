/**
 * Turning a document's formula into a cross-fact metric - and refusing when it is not one.
 *
 * A定义 like `捕获率 = gmv / revenue` names two metrics that live on different fact tables. Read literally the
 * formula is a division of two *metric ids*, which no SQL can evaluate; read usefully it means "each side
 * aggregated at its own grain, then divided". That reading is only safe when both sides resolve to metrics that
 * exist and that can be grouped by at least one shared dimension, so this file resolves the names, checks the
 * shared dimensions, and otherwise leaves the metric as it was (the review queue is where an unreadable formula
 * belongs, not the query path).
 *
 * The resolved metric keeps `metricKind: 'ratio'` and gains `crossFact`. `expression` becomes the readable
 * `metric/gmv / metric/revenue` so the model, the UI and the provenance all show what it means without pretending
 * it is a single-table aggregate.
 */

import { relationId, type Candidate, type MetricPayload } from '../../contracts/src/index.ts';
import type { ModelIndex } from './sql.ts';
import type { MergedCandidate } from './merge.ts';

export interface CrossFactResolution {
  candidates: MergedCandidate[];
  resolved: string[];
  notes: string[];
}

export function resolveCrossFactMetrics(candidates: MergedCandidate[], index: ModelIndex): CrossFactResolution {
  const notes: string[] = [];
  const resolved: string[] = [];
  const metrics = new Map(index.metrics.map((metric) => [metric.id, metric]));

  for (const candidate of candidates) {
    if (candidate.kind !== 'entity' || candidate.entityType !== 'metric') continue;
    const payload = candidate.payload as MetricPayload;
    if (payload.crossFact) continue;

    const sides = directMetricReferences(payload, metrics);
    if (!sides) continue;

    const numerator = metrics.get(sides.numerator)!;
    const denominator = metrics.get(sides.denominator)!;
    if (numerator.id === denominator.id) {
      notes.push(`${candidate.id}: 两侧是同一个指标，忽略`);
      continue;
    }

    const numeratorDims = new Set(index.groupedBy.filter((edge) => edge.from === numerator.id).map((edge) => edge.to));
    const shared = index.groupedBy
      .filter((edge) => edge.from === denominator.id && numeratorDims.has(edge.to))
      .map((edge) => edge.to);
    if (shared.length === 0) {
      // both sides exist but nothing can group them together: a formula nobody can query is a review item
      candidate.status = 'needs_review';
      candidate.note = `${numerator.payload.name} 与 ${denominator.payload.name} 没有共同的切片维度，跨事实指标无法下钻`;
      notes.push(`${candidate.id}: 两侧没有共同维度，保留为待审`);
      continue;
    }

    payload.crossFact = { numerator: numerator.id, denominator: denominator.id };
    payload.formula = undefined;
    payload.expression = `${numerator.id} / ${denominator.id}`;
    payload.aggFunction = 'RATIO';
    payload.metricKind = 'ratio';
    payload.additive = false;
    payload.tables = [...new Set([...(numerator.payload.tables ?? []), ...(denominator.payload.tables ?? [])])];
    payload.columns = [...new Set([...(numerator.payload.columns ?? []), ...(denominator.payload.columns ?? [])])];
    resolved.push(candidate.id);
    notes.push(`${candidate.id}: 跨事实指标（${numerator.id} / ${denominator.id}），共享维度 ${shared.join(', ')}`);

    // The model has to say the metric *can* be sliced by the shared dimensions, otherwise every consumer -
    // the interpreter, attribution, the probes - sees a metric with no slices and refuses questions it could answer.
    for (const dimensionId of shared) {
      candidates.push({
        id: relationId(candidate.id, 'groupedBy', dimensionId),
        kind: 'relation',
        relationType: 'groupedBy',
        from: candidate.id,
        to: dimensionId,
        payload: { derivedFrom: 'crossFact' },
        provenance: 'parser',
        confidence: 0.9,
        evidence: candidate.evidence.slice(0, 1),
        status: 'candidate',
        // a derived edge carries the same snapshot shape as a merged candidate
        observations: [{ provenance: 'parser', sourceFile: candidate.evidence[0]?.sourceFile ?? '(derived)' }],
        conflictIds: [],
      });
    }
  }

  return { candidates, resolved, notes };
}

/**
 * `capture_rate = gmv / revenue` -> the two metric ids, or null.
 *
 * A side is a metric reference when it is a bare identifier that resolves to a metric; anything with a
 * parenthesis, an operator or a dot is SQL and is left to the ordinary ratio path.
 */
function directMetricReferences(payload: MetricPayload, metrics: Map<string, ModelIndex['metrics'][number]>):
{ numerator: string; denominator: string } | null {
  const expression = payload.formula
    ? `${payload.formula.numerator} / ${payload.formula.denominator}`
    : payload.expression;
  if (!expression) return null;
  const parts = expression.split('/').map((part) => part.trim());
  if (parts.length !== 2) return null;
  const resolve = (text: string): string | null => {
    if (!/^[A-Za-z_][\w-]*$/.test(text)) return null;
    const match = [...metrics.values()].find((metric) =>
      metric.id === text || metric.payload.name === text || `metric/${metric.payload.name}` === text);
    return match?.id ?? null;
  };
  const numerator = resolve(parts[0]!);
  const denominator = resolve(parts[1]!);
  return numerator && denominator ? { numerator, denominator } : null;
}
