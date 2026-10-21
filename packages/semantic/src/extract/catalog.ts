/**
 * What the catalog and a profile can say that no document will: the grain, the keys nobody declared, the
 * columns that are really dimensions, and which fields are personal data.
 *
 * This is the source that turns a *documented* model into a *usable* one. A DDL dump tells you a table has a
 * primary key; only the profile tells you it is unique in the data. A naming convention suggests `region_id`
 * is a foreign key; only measuring it, then joining, makes that a fact. And a column called `region_name` with
 * four values is a dimension whether or not any report happened to group by it.
 *
 * Three deliberate restraints, because machine-discovered structure is where a semantic layer goes wrong:
 *
 * 1. **A discovered FK must match by name, not by values.** `region_id` joins `dim_region.region_id`; the
 *    demo's `industry_id` (1..3) also matches `dim_region.region_id` (1..4) by value, and joining on that
 *    would validate the wrong thing. Values only decide the probe's verdict, never the candidate.
 * 2. **A dimension candidate never displaces an existing binding.** If a report already groups by
 *    `dim_region.region_name` as `region`, the catalog does not propose a second `dim/region` on `region_id`.
 * 3. **Everything discovered is a candidate with its evidence**, so the review queue shows "this FK was not
 *    declared anywhere" instead of a model that quietly invented it.
 */

import type { Catalog } from '../../../dataplane/src/sqlite.ts';
import type { TableProfile } from '../../../dataplane/src/profile.ts';
import {
  columnId,
  dimId,
  relationId,
  tableId,
  type Candidate,
  type ColumnPayload,
} from '../../../contracts/src/index.ts';

export interface CatalogExtraction {
  candidates: Candidate[];
  notes: string[];
}

const DATE_TYPES = /DATE|TIMESTAMP|DATETIME/i;
const SENSITIVE = /email|mail|phone|mobile|id_card|idcard|address|bank|passwd|password|ssn/i;
const MAX_DIMENSION_CARDINALITY = 30;
const MIN_ROWS_FOR_PROFILE = 20;

export function extractFromCatalog(catalog: Catalog, profiles: TableProfile[], known: Candidate[]): CatalogExtraction {
  const candidates: Candidate[] = [];
  const notes: string[] = [];
  const profileOf = new Map(profiles.map((profile) => [profile.table, profile]));

  const boundColumns = new Set<string>();
  const dimNames = new Set<string>();
  const declaredReferences = new Set<string>();
  for (const candidate of known) {
    if (candidate.entityType === 'dimension') {
      const column = (candidate.payload as { column?: string }).column;
      if (column) boundColumns.add(column);
      dimNames.add(candidate.id);
    }
    if (candidate.relationType === 'references' && candidate.from) declaredReferences.add(candidate.from);
  }

  const metrics = known.filter((candidate) => candidate.entityType === 'metric')
    .map((candidate) => ({
      id: candidate.id,
      tables: ((candidate.payload as { tables?: string[] }).tables ?? []),
    }));

  for (const table of catalog.tables) {
    const profile = profileOf.get(table.name);
    if (!profile) continue;
    const evidence = (quote: string): Candidate['evidence'][number] => ({
      kind: 'catalog',
      sourceFile: `catalog/${table.name}`,
      quote,
    });

    const grain = table.primaryKey;
    candidates.push({
      id: tableId(table.name),
      kind: 'entity',
      entityType: 'table',
      payload: {
        name: table.name,
        ...(grain.length > 0 ? { grain } : {}),
        rowCount: profile.rowCount,
      },
      provenance: 'catalog',
      confidence: 1,
      evidence: [evidence(`profiled ${table.name}: ${profile.rowCount} rows`
        + `${grain.length > 0 ? `, grain (${grain.join(', ')})` : ', no primary key'}`)],
      status: 'candidate',
      ...(grain.length === 0 ? { note: '没有声明主键，粒度未经证实' } : {}),
    });
    if (grain.length === 0) notes.push(`${table.name}: no primary key declared, grain is unproven`);

    // --- columns: the measured facts
    for (const column of profile.columns) {
      const isGrain = grain.includes(column.name);
      const payload: ColumnPayload = {
        name: column.name,
        table: table.name,
        dataType: column.dataType,
        columnRole: isGrain ? 'PK' : 'attribute',
        isGrain,
        cardinality: column.distinct,
        nullRate: column.nullRate,
        ...(column.topValues ? { topValues: column.topValues } : {}),
        ...(SENSITIVE.test(column.name) ? { sensitivity: 'pii' as const } : {}),
      };
      candidates.push({
        id: columnId(table.name, column.name),
        kind: 'entity',
        entityType: 'column',
        payload,
        provenance: 'catalog',
        confidence: 1,
        evidence: [evidence(`profiled ${table.name}.${column.name}: ${column.distinct} distinct, `
          + `${(column.nullRate * 100).toFixed(1)}% null`)
        ],
        status: 'candidate',
      });
      if (payload.sensitivity === 'pii') {
        notes.push(`${table.name}.${column.name} is classified PII by name; it stays out of prompt text and default result sets`);
      }
    }

    // --- foreign keys nobody declared, discovered from the name and then measured
    for (const column of profile.columns) {
      const id = columnId(table.name, column.name);
      if (declaredReferences.has(id)) continue;
      const base = /^(.+)_id$/i.exec(column.name)?.[1];
      if (!base) continue;
      const target = findReferencedTable(catalog, base, column.name);
      if (!target || target.table === table.name) continue;
      const referenceId = relationId(id, 'references', target.column);
      if (declaredReferences.has(referenceId)) continue;
      declaredReferences.add(id);
      candidates.push({
        id: referenceId,
        kind: 'relation',
        relationType: 'references',
        from: id,
        to: target.column,
        payload: { declaredBy: 'discovered', matchedOn: 'naming pattern' },
        provenance: 'catalog',
        confidence: 0.7,
        evidence: [evidence(`${table.name}.${column.name} -> ${target.column} `
          + `(no FOREIGN KEY declared; discovered from the ${base}_id naming pattern)`)],
        status: 'candidate',
        note: '外键在 DDL 里没有声明，由命名模式发现；references 探针会验证它',
      });
      notes.push(`${table.name}.${column.name} -> ${target.column}: FK discovered, pending the join probe`);
    }

    // --- dimensions: low cardinality, not a key, and not already bound by a report
    // A fact table's `region_id` is a join key; the dimension is `dim_region.region_name`. Proposing a
    // dimension on the FK column gives one dimension id two physical bindings depending on file order, and
    // that breaks the join path for every other fact table.
    const foreignKeyColumns = new Set(
      profile.columns
        .filter((column) => /^(.+)_id$/i.test(column.name))
        .filter((column) => findReferencedTable(catalog, /^(.+)_id$/i.exec(column.name)![1]!, column.name) !== null)
        .map((column) => column.name),
    );
    // A dimension table (`dim_campaign`) has a unique label column - uniqueness is what makes it a table,
    // not what disqualifies it from being a dimension. So the uniqueness filter applies to fact-side
    // columns only; a `dim_*` (or FK-referenced) table may contribute a dimension at any cardinality up to
    // the cap.
    const isDimensionTable = /^dim_/i.test(table.name)
      || catalog.tables.some((other) => other.foreignKeys.some((fk) => fk.refTable === table.name));
    const dimensionCandidates = profile.columns
      .filter((column) => !grain.includes(column.name))
      .filter((column) => !foreignKeyColumns.has(column.name))
      .filter((column) => column.distinct > 0 && column.distinct <= MAX_DIMENSION_CARDINALITY)
      .filter((column) => profile.rowCount >= MIN_ROWS_FOR_PROFILE)
      .filter((column) => column.uniqueness < 0.5 || isDimensionTable)
      .filter((column) => !boundColumns.has(columnId(table.name, column.name)));
    // names first: a dimension should be called `campaign` (from campaign_name), not `campaign_id`
    dimensionCandidates.sort((a, b) => Number(/_name$/i.test(a.name)) < Number(/_name$/i.test(b.name)) ? 1 : 0
      || Number(/_id$/i.test(a.name)) - Number(/_id$/i.test(b.name)));

    for (const column of dimensionCandidates) {
      const base = column.name.replace(/_(id|name|type|code|desc|key)$/i, '');
      const id = dimId(base);
      if (dimNames.has(id)) continue;
      dimNames.add(id);
      candidates.push({
        id,
        kind: 'entity',
        entityType: 'dimension',
        payload: {
          name: base,
          column: columnId(table.name, column.name),
          dataType: column.dataType,
          cardinality: column.distinct,
          ...(column.topValues ? { valueSample: column.topValues.map((entry) => entry.value) } : {}),
        },
        provenance: 'catalog',
        confidence: 0.75,
        evidence: [evidence(`${table.name}.${column.name}: ${column.distinct} distinct values, `
          + `not a key (uniqueness ${(column.uniqueness * 100).toFixed(1)}%)`)],
        status: 'candidate',
        note: '由数据概况发现的维度：低基数且非键',
      });
    }

    // --- time grains: a date column is a hierarchy, not a single level
    const dateColumn = profile.columns.find((column) => DATE_TYPES.test(column.dataType) && column.distinct > 1);
    if (dateColumn) {
      const column = columnId(table.name, dateColumn.name);
      const columnName = dateColumn.name;
      for (const level of ['month', 'quarter', 'year'] as const) {
        const id = dimNames.has(dimId(level)) ? dimId(`${table.name}_${level}`) : dimId(level);
        if (dimNames.has(id)) continue;
        dimNames.add(id);
        const expression = timeGrainExpression(level, columnName);
        candidates.push({
          id,
          kind: 'entity',
          entityType: 'dimension',
          payload: {
            name: level,
            column,
            expression,
            level,
            dataType: dateColumn.dataType,
            cardinality: level === 'year' ? Math.min(10, dateColumn.distinct) : dateColumn.distinct,
          },
          provenance: 'catalog',
          confidence: 0.9,
          evidence: [evidence(`${table.name}.${columnName} is a date column; ${level} level = ${expression}`)],
          status: 'candidate',
        });
        candidates.push({
          id: relationId(id, 'dimensionColumn', column),
          kind: 'relation',
          relationType: 'dimensionColumn',
          from: id,
          to: column,
          payload: {},
          provenance: 'catalog',
          confidence: 0.9,
          evidence: [evidence(`${level} over ${table.name}.${columnName}`)],
          status: 'candidate',
        });
        // every metric measured on this table can be sliced by this time level
        for (const metric of metrics.filter((entry) => entry.tables.includes(table.name))) {
          candidates.push({
            id: relationId(metric.id, 'groupedBy', id),
            kind: 'relation',
            relationType: 'groupedBy',
            from: metric.id,
            to: id,
            payload: { discoveredBy: 'time grain' },
            provenance: 'catalog',
            confidence: 0.9,
            evidence: [evidence(`${metric.id} is measured on ${table.name}, so ${level} slices it`)],
            status: 'candidate',
          });
        }
      }
    }
  }

  // --- the time hierarchy, when the levels exist
  const levels = ['dim/stat_date', 'dim/month', 'dim/quarter', 'dim/year'];
  for (let i = 0; i + 1 < levels.length; i++) {
    const from = levels[i]!;
    const to = levels[i + 1]!;
    if (!dimNames.has(from) || !dimNames.has(to)) continue;
    candidates.push({
      id: relationId(from, 'hierarchy', to),
      kind: 'relation',
      relationType: 'hierarchy',
      from,
      to,
      payload: { rollup: true },
      provenance: 'catalog',
      confidence: 0.9,
      evidence: [{ kind: 'catalog', sourceFile: 'catalog/levels', quote: `${from} rolls up into ${to}` }],
      status: 'candidate',
    });
  }

  return { candidates, notes };
}

/** `region_id` -> `dim_region.region_id` (or `region.region_id`), by table **name**, never by values. */
function findReferencedTable(catalog: Catalog, base: string, columnName: string): { table: string; column: string } | null {
  const wanted = base.toLowerCase();
  const matches = catalog.tables.filter((table) => {
    const name = table.name.toLowerCase();
    return name === wanted || name === `dim_${wanted}` || name === `${wanted}s` || name === `${wanted}_dim`
      || name === `d_${wanted}`;
  });
  for (const table of matches) {
    const pk = table.primaryKey.find((column) => column.toLowerCase() === columnName.toLowerCase())
      ?? table.primaryKey[0];
    if (pk) return { table: table.name, column: `column/${table.name}.${pk}` };
  }
  return null;
}

/** Portable across SQLite/MySQL/Postgres: no `date_trunc`, because the semantic layer must not bake in one. */
export function timeGrainExpression(level: 'month' | 'quarter' | 'year', column: string): string {
  switch (level) {
    case 'year':
      return `substr(${column}, 1, 4)`;
    case 'quarter':
      return `substr(${column}, 1, 4) || '-Q' || ((cast(substr(${column}, 6, 2) as integer) + 2) / 3)`;
    case 'month':
      return `substr(${column}, 1, 7)`;
  }
}
