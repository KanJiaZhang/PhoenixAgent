/**
 * Profiling: the difference between what a schema *says* and what the data *is*.
 *
 * Every enterprise has columns that lie. `region_id` in one table is a code, in another it is a name; a
 * "primary key" is sometimes not unique; a column called `status` has four values in production and twelve in
 * the design document; a `*_id` column has no declared foreign key but joins perfectly. None of that is
 * visible in DDL, and all of it decides whether a semantic layer is usable.
 *
 * So the profile measures, per table: row count, and per column null rate, distinct count, min/max, and (for
 * a low-cardinality column) the top values. Those five numbers are what the catalog extractor needs to
 *
 * - confirm a declared grain (`is the primary key actually unique?`) - the check that catches a duplicate
 *   fact row, which is the most expensive silent error in analytics,
 * - discover a foreign key the DDL forgot (naming pattern + a join probe, never a guess from values alone),
 * - tell a dimension from an id (`region_name` has 4 values; `order_id` has 2 600),
 * - catch a field that is 100% null, or a "measure" that is entirely zero,
 * - name the values an enum filter in a metric's口径 relies on.
 *
 * Cost is one query per column on a small table; on a warehouse the caller samples (`WHERE` a time window) -
 * the shape of the answer does not change.
 */

import type { Catalog, QueryRunner, TableMeta } from './sqlite.ts';

export interface ColumnProfile {
  name: string;
  dataType: string;
  rowCount: number;
  nonNull: number;
  nullRate: number;
  distinct: number;
  /** distinct / nonNull; 1 means the column identifies its row. */
  uniqueness: number;
  min?: unknown;
  max?: unknown;
  topValues?: { value: unknown; count: number }[];
}

export interface TableProfile {
  table: string;
  rowCount: number;
  columns: ColumnProfile[];
}

export interface ProfileOptions {
  /** Distinct values at or below this are worth listing (and are what a dimension looks like). */
  topValuesBelow?: number;
  /** Give up after this many distinct values in the GROUP BY probe. */
  maxRows?: number;
}

const DEFAULTS: ProfileOptions = { topValuesBelow: 20, maxRows: 200 };

export function profileCatalog(run: QueryRunner, catalog: Catalog, options: ProfileOptions = {}): TableProfile[] {
  const settings = { ...DEFAULTS, ...options };
  return catalog.tables.map((table) => profileTable(run, table, settings));
}

export function profileTable(run: QueryRunner, table: TableMeta, options: ProfileOptions = {}): TableProfile {
  const settings = { ...DEFAULTS, ...options };
  const columns: ColumnProfile[] = [];
  for (const column of table.columns) {
    const name = quote(column.name);
    const stats = run(
      `SELECT COUNT(*) AS n, COUNT(${name}) AS non_null, COUNT(DISTINCT ${name}) AS distinct_values FROM ${quote(table.name)}`,
    ).rows[0] ?? {};
    const rowCount = Number(stats.n ?? 0);
    const nonNull = Number(stats.non_null ?? 0);
    const distinct = Number(stats.distinct_values ?? 0);

    const profile: ColumnProfile = {
      name: column.name,
      dataType: column.dataType,
      rowCount,
      nonNull,
      nullRate: rowCount === 0 ? 0 : round((rowCount - nonNull) / rowCount),
      distinct,
      uniqueness: nonNull === 0 ? 0 : round(distinct / nonNull),
    };

    if (nonNull > 0 && isComparable(column.dataType)) {
      const range = run(`SELECT MIN(${name}) AS lo, MAX(${name}) AS hi FROM ${quote(table.name)}`).rows[0] ?? {};
      if (range.lo !== null && range.lo !== undefined) profile.min = range.lo;
      if (range.hi !== null && range.hi !== undefined) profile.max = range.hi;
    }

    if (distinct > 0 && distinct <= (settings.topValuesBelow ?? DEFAULTS.topValuesBelow!) && rowCount > 0) {
      profile.topValues = run(
        `SELECT ${name} AS value, COUNT(*) AS occurrences FROM ${quote(table.name)}
         GROUP BY ${name} ORDER BY occurrences DESC, value LIMIT 5`,
      ).rows.map((row) => ({ value: row.value, count: Number(row.occurrences ?? 0) }));
    }

    columns.push(profile);
  }
  return { table: table.name, rowCount: table.columns.length === 0 ? 0 : (columns[0]?.rowCount ?? 0), columns };
}

function isComparable(dataType: string): boolean {
  return !/BLOB|JSON/i.test(dataType);
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
