/**
 * Domain scope: which tables belong to the semantic model being built.
 *
 * One warehouse holds several domains, and a model that swallows all of them stops being a model: the risk
 * tables add `is_fraud` as a "dimension", the coverage numbers get diluted by tables nobody will ever query from
 * the ad domain, and the review queue fills with candidates nobody asked for. The boundary is therefore declared
 * in `fixtures/<scenario>/scope.json` - data, with a reason - rather than guessed from table prefixes in code.
 *
 * Excluding a table removes it from the catalog the extractors see, and drops any candidate that names it. A
 * metric whose every source table is excluded goes too; a metric that also reads a kept table stays, because
 * part of its lineage is in this domain.
 */

import type { Catalog } from '../../dataplane/src/sqlite.ts';
import type { Candidate, MetricPayload } from '../../contracts/src/index.ts';
import { tableOfColumn } from '../../contracts/src/index.ts';

export interface Scope {
  excludeTables: string[];
  reason?: string;
}

export const EMPTY_SCOPE: Scope = { excludeTables: [] };

export function scopeCatalog(catalog: Catalog, scope: Scope): Catalog {
  if (scope.excludeTables.length === 0) return catalog;
  const excluded = new Set(scope.excludeTables);
  return { ...catalog, tables: catalog.tables.filter((table) => !excluded.has(table.name)) };
}

export function scopeCandidates(candidates: Candidate[], scope: Scope): { candidates: Candidate[]; dropped: string[] } {
  if (scope.excludeTables.length === 0) return { candidates, dropped: [] };
  const excluded = new Set(scope.excludeTables);
  const dropped: string[] = [];

  const kept = candidates.filter((candidate) => {
    const id = candidate.id;
    if (id.startsWith('table/')) {
      if (excluded.has(id.slice('table/'.length))) {
        dropped.push(id);
        return false;
      }
    }
    if (id.startsWith('column/')) {
      if (excluded.has(tableOfColumn(id))) {
        dropped.push(id);
        return false;
      }
    }
    if (candidate.kind === 'relation') {
      const from = candidate.from ?? '';
      const to = candidate.to ?? '';
      const touches = [from, to].some((endpoint) =>
        (endpoint.startsWith('table/') && excluded.has(endpoint.slice('table/'.length)))
        || (endpoint.startsWith('column/') && excluded.has(tableOfColumn(endpoint))));
      if (touches) {
        dropped.push(id);
        return false;
      }
    }
    if (candidate.entityType === 'metric') {
      const tables = (candidate.payload as MetricPayload).tables ?? [];
      if (tables.length > 0 && tables.every((table) => excluded.has(table))) {
        dropped.push(id);
        return false;
      }
    }
    return true;
  });

  return { candidates: kept, dropped };
}
