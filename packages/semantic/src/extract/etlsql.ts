/**
 * Extracts metric definitions, lineage, dimensions and join paths from the SQL the business already runs.
 *
 * The insight this module is built on: an enterprise does not need an agent to invent metrics, it needs one
 * to read the metrics it already agreed on. A production report *is* the definition - the aggregate under the
 * alias, the `GROUP BY` that says what it can be sliced by, the `ON` that says how the tables join, and the
 * `WHERE status = 'paid'` that says what the definition excludes. So the ETL corpus is the highest-value
 * source in the whole pipeline, and it is read deterministically.
 *
 * Two distinctions that matter and are easy to get wrong:
 *
 * - **A categorical filter is the definition; a date range is not.** `status = 'paid'` is part of what GMV
 *   means. `date_key >= '2024-01-01'` is one report's window. The first goes into `filters` (and into every
 *   probe), the second becomes a note, because baking a window into a metric is how口径 rot starts.
 * - **A ratio metric is not a base metric.** `SUM(revenue) / SUM(spend)` is stored as a `ratio` with its two
 *   sides, so the `formula` probe can check the identity per slice - and so attribution can later decompose
 *   the two drivers instead of pretending the ratio is additive.
 */

import { analyzeSql } from '../../../sqlkit-ts/src/select.ts';
import { tokenize } from '../../../sqlkit-ts/src/tokenize.ts';
import {
  columnId,
  dimId,
  metricId,
  relationId,
  type Candidate,
  type DimensionPayload,
  type MetricPayload,
} from '../../../contracts/src/index.ts';
import type { Catalog } from '../../../dataplane/src/sqlite.ts';

export interface EtlExtraction {
  candidates: Candidate[];
  notes: string[];
}

export function extractFromEtl(sourceFile: string, sql: string, catalog: Catalog): EtlExtraction {
  const candidates: Candidate[] = [];
  const notes: string[] = [];
  const knownColumns = indexColumns(catalog);
  const knownTables = new Set(catalog.tables.map((t) => t.name));

  for (const analysis of analyzeSql(sql)) {
    // A view is a named query: it keeps its own id so `derivedFrom` can point at what it reads. A load
    // (`INSERT INTO tgt SELECT`) keeps the file-based id and gains a `writes` edge to its target, because
    // the useful question is "where does ads_region_month come from", not "what is this job called".
    const queryNodeId = analysis.view
      ? `query/view:${analysis.view}`
      : `query/${basename(sourceFile)}#${analysis.statementIndex}`;
    const queryName = analysis.view ?? `${basename(sourceFile)}#${analysis.statementIndex}`;
    const queryEvidence = {
      kind: 'etl' as const,
      sourceFile,
      span: [0, analysis.sql.length] as [number, number],
      quote: analysis.sql.slice(0, 200),
      statement: analysis.statementIndex,
    };
    candidates.push({
      id: queryNodeId,
      kind: 'entity',
      entityType: 'query',
      payload: {
        name: queryName,
        sqlText: analysis.sql,
        tables: analysis.tables,
        ...(analysis.view ? { kind: 'view' } : {}),
        ...(analysis.target ? { writes: analysis.target.table } : {}),
      },
      provenance: 'parser',
      confidence: 1,
      evidence: [queryEvidence],
      status: 'candidate',
    });

    for (const table of analysis.tables) {
      if (!knownTables.has(table)) continue;
      const relationType = analysis.view ? 'derivedFrom' : null;
      if (!relationType) break;
      candidates.push({
        id: relationId(queryNodeId, relationType, `table/${table}`),
        kind: 'relation',
        relationType,
        from: queryNodeId,
        to: `table/${table}`,
        payload: {},
        provenance: 'parser',
        confidence: 1,
        evidence: [queryEvidence],
        status: 'candidate',
      });
    }

    if (analysis.target) {
      candidates.push({
        id: relationId(queryNodeId, 'writes', `table/${analysis.target.table}`),
        kind: 'relation',
        relationType: 'writes',
        from: queryNodeId,
        to: `table/${analysis.target.table}`,
        payload: { columns: analysis.target.columns },
        provenance: 'parser',
        confidence: 1,
        evidence: [queryEvidence],
        status: 'candidate',
      });
    }

    const missingTables = analysis.tables.filter((t) => !knownTables.has(t));
    if (missingTables.length > 0) {
      notes.push(`${sourceFile}#${analysis.statementIndex}: reads tables the catalog does not have: ${missingTables.join(', ')}`);
    }

    // --- metrics: an aggregate with an alias is a definition somebody already agreed on
    const metricIdsInQuery: string[] = [];
    for (const projection of analysis.projections) {
      if (!projection.agg || !projection.alias) {
        if (projection.agg && !projection.alias) {
          notes.push(`${sourceFile}#${analysis.statementIndex}: aggregate without an alias is not a metric candidate: ${projection.expression}`);
        }
        continue;
      }
      const id = metricId(projection.alias);
      metricIdsInQuery.push(id);

      const ratio = splitRatio(projection.expression);
      const tables = unique(projection.columns.map((c) => c.split('.')[0]!)).filter((t) => knownTables.has(t));
      const columns = projection.columns.filter((c) => knownColumns.has(c));
      for (const unresolved of projection.unresolved) {
        notes.push(`${sourceFile}#${analysis.statementIndex}: column '${unresolved}' of ${projection.alias} did not resolve to one table`);
      }

      const payload: MetricPayload = {
        name: projection.alias,
        expression: projection.expression,
        aggFunction: ratio ? 'RATIO' : projection.agg,
        metricKind: ratio ? 'ratio' : 'base',
        ...(ratio ? { formula: ratio } : {}),
        tables: tables.length > 0 ? tables : unique(analysis.tables),
        columns,
        filters: categoricalFilters(analysis.filters),
      };
      candidates.push({
        id,
        kind: 'entity',
        entityType: 'metric',
        payload,
        provenance: 'parser',
        confidence: 1,
        evidence: [{
          kind: 'etl',
          sourceFile,
          span: projection.span,
          quote: projection.text,
          statement: analysis.statementIndex,
        }],
        status: 'candidate',
      });

      for (const used of columns) {
        candidates.push(relation(sourceFile, id, 'usesColumn', columnId(used.split('.')[0]!, used.split('.')[1]!), projection.text, projection.span));
      }
      for (const table of payload.tables) {
        candidates.push(relation(sourceFile, id, 'computedFrom', `table/${table}`, projection.text, projection.span));
      }
      candidates.push(relation(sourceFile, id, 'definedBy', queryNodeId, projection.text, projection.span));
    }

    // --- dimensions: what the report groups by is what the metric can be sliced by
    for (const item of analysis.groupBy) {
      if (!item.column) {
        notes.push(`${sourceFile}#${analysis.statementIndex}: GROUP BY '${item.text}' is an expression, kept as a note only`);
        continue;
      }
      const table = item.column.split('.')[0]!;
      const columnName = item.column.split('.')[1]!;
      if (!knownColumns.has(item.column)) {
        notes.push(`${sourceFile}#${analysis.statementIndex}: GROUP BY column '${item.column}' is not in the catalog`);
        continue;
      }
      // The report's own alias is the better name for the dimension: `r.region_name AS region` means the
      // business calls this dimension "region", and the wiki will say 大区（region）. Falling back to the
      // bare column name keeps it working when the projection has no alias, and `_id` is dropped because a
      // dimension is the thing, not its key.
      const projection = analysis.projections.find(
        (entry) => entry.alias && entry.columns.length === 1 && entry.columns[0] === item.column,
      );
      const dimensionName = (projection?.alias ?? columnName).replace(/_id$/, '');
      const id = dimId(dimensionName);
      // A `GROUP BY fact.region_id` slices by the *dimension table's* label, not by the fact's key: binding
      // the dimension to `fact_ad_daily.region_id` would give one dimension id two physical columns (one per
      // report) and break the join path for every other fact table.
      const binding = dimensionBinding(catalog, table, columnName);
      const payload: DimensionPayload = {
        name: dimensionName,
        column: columnId(binding.table, binding.column),
        dataType: binding.dataType,
        alias: unique([
          columnName,
          binding.column,
          ...(projection?.alias ? [projection.alias] : []),
          // a date column is the date dimension; documents say 日期（date）
          ...(/DATE|TIMESTAMP/i.test(binding.dataType) ? ['date'] : []),
        ]),
      };
      candidates.push({
        id,
        kind: 'entity',
        entityType: 'dimension',
        payload,
        provenance: 'parser',
        confidence: 1,
        evidence: [{
          kind: 'etl',
          sourceFile,
          span: item.span ?? [0, 0],
          quote: `GROUP BY ${item.text}`,
          statement: analysis.statementIndex,
        }],
        status: 'candidate',
      });
      candidates.push(relation(sourceFile, id, 'dimensionColumn', columnId(table, columnName), `GROUP BY ${item.text}`, item.span));
      for (const metric of metricIdsInQuery) {
        candidates.push(relation(sourceFile, metric, 'groupedBy', id, `GROUP BY ${item.text}`, item.span));
      }
    }

    // --- join paths: an `ON a.x = b.y` is a `references` edge, and a claim the probe can test
    for (const join of analysis.joins) {
      if (!knownColumns.has(join.left) || !knownColumns.has(join.right)) {
        notes.push(`${sourceFile}#${analysis.statementIndex}: join '${join.text}' did not resolve to two catalog columns`);
        continue;
      }
      const left = columnId(...splitColumn(join.left));
      const right = columnId(...splitColumn(join.right));
      // the edge points from the fact side to the dimension side: the side whose column is not a key
      const from = isKeyColumn(catalog, right) || !isKeyColumn(catalog, left) ? left : right;
      const to = from === left ? right : left;
      candidates.push({
        id: relationId(from, 'references', to),
        kind: 'relation',
        relationType: 'references',
        from,
        to,
        payload: { foundIn: 'JOIN ON' },
        provenance: 'parser',
        confidence: 1,
        evidence: [{ kind: 'etl', sourceFile, span: [0, 0], quote: join.text, statement: analysis.statementIndex }],
        status: 'candidate',
      });
    }
  }

  return { candidates, notes };
}

/** `SUM(a) / NULLIF(SUM(b), 0)` -> the two sides. Null when the division is not a top-level one. */
export function splitRatio(expression: string): { numerator: string; denominator: string } | null {
  const tokens = tokenize(expression);
  const slashes = tokens.filter((t) => t.value === '/' && t.depth === 0);
  if (slashes.length !== 1) return null;
  const slash = slashes[0]!;
  const left = expression.slice(0, slash.start).trim();
  const right = expression.slice(slash.end).trim();
  if (left.length === 0 || right.length === 0) return null;
  // the right side must be a scalar (possibly wrapped in NULLIF), not another division
  return { numerator: left, denominator: right };
}

/** Equality filters with a literal are口径; ranges are one report's window and are reported, not baked in. */
function categoricalFilters(filters: { text: string; column?: string; op?: string; value?: string }[]): string[] {
  const out: string[] = [];
  for (const filter of filters) {
    if (!filter.column) continue;
    if (filter.op === '=' && filter.value?.startsWith("'")) out.push(`${filter.column} ${filter.op} ${filter.value}`.trim());
  }
  return out;
}

function indexColumns(catalog: Catalog): Set<string> {
  const set = new Set<string>();
  for (const table of catalog.tables) for (const column of table.columns) set.add(`${table.name}.${column.name}`);
  return set;
}

function lookupType(catalog: Catalog, table: string, column: string): string {
  return catalog.tables.find((t) => t.name === table)?.columns.find((c) => c.name === column)?.dataType ?? '';
}

/**
 * Where a dimension physically lives.
 *
 * A group-by on `fact_ad_daily.region_id` means "by region", and region is described in `dim_region`: the
 * label column is what a reader recognises, and it is what the other fact tables can join to. So an FK column
 * resolves to its target table's label column; everything else resolves to itself.
 */
export function dimensionBinding(catalog: Catalog, table: string, column: string): { table: string; column: string; dataType: string } {
  const meta = catalog.tables.find((entry) => entry.name === table);
  const fk = meta?.foreignKeys.find((entry) => entry.column === column);
  if (!fk) return { table, column, dataType: lookupType(catalog, table, column) };
  const target = catalog.tables.find((entry) => entry.name === fk.refTable);
  if (!target) return { table, column, dataType: lookupType(catalog, table, column) };
  const label = target.columns.find((entry) => /_name$/i.test(entry.name))
    ?? target.columns.find((entry) => !target.primaryKey.includes(entry.name) && /CHAR|TEXT/i.test(entry.dataType));
  if (!label) return { table, column, dataType: lookupType(catalog, table, column) };
  return { table: target.name, column: label.name, dataType: label.dataType };
}

function isKeyColumn(catalog: Catalog, column: string): boolean {
  const [table, name] = splitColumn(column);
  const meta = catalog.tables.find((t) => t.name === table);
  if (!meta) return false;
  return meta.primaryKey.includes(name!) || meta.foreignKeys.some((fk) => fk.column === name);
}

function splitColumn(column: string): [string, string] {
  const dot = column.indexOf('.');
  return dot < 0 ? [column, ''] : [column.slice(0, dot), column.slice(dot + 1)];
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function relation(sourceFile: string, from: string, type: Candidate['relationType'], to: string, quote: string,
  span?: [number, number]): Candidate {
  return {
    id: relationId(from, type!, to),
    kind: 'relation',
    relationType: type,
    from,
    to,
    payload: {},
    provenance: 'parser',
    confidence: 1,
    evidence: [{ kind: 'etl', sourceFile, span: span ?? [0, 0], quote }],
    status: 'candidate',
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

