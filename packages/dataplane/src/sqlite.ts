/**
 * The physical truth about a warehouse: which tables exist, which columns, which keys, how big.
 *
 * SQLite is the P1 driver, not the product. The point of the interface is that the extractors and the
 * probes never see a connection: they see a {@link Catalog} value and a {@link QueryRunner} function. When
 * the MySQL/Postgres/Doris drivers arrive they implement the same two things, and every probe keeps
 * working - including the one that decides whether an FK declaration is actually true.
 */

import { DatabaseSync } from 'node:sqlite';

export interface ColumnMeta {
  name: string;
  /** The declared type, as the catalog spells it: `VARCHAR(32)`, `DECIMAL(15,2)`. */
  dataType: string;
  notNull: boolean;
  primaryKey: boolean;
  position: number;
  defaultValue: string | null;
}

export interface TableMeta {
  name: string;
  columns: ColumnMeta[];
  primaryKey: string[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  foreignKeys: { column: string; refTable: string; refColumn: string }[];
  rowCount: number;
}

export interface Catalog {
  source: string;
  fetchedAt: string;
  tables: TableMeta[];
  notes: string[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

/** Runs one read-only statement. Every module that touches data goes through this. */
export type QueryRunner = (sql: string) => QueryResult;

/** Reads the catalog out of a SQLite database. Comments are not here: they live in the DDL text. */
export function readSqliteCatalog(db: DatabaseSync, source = 'sqlite'): Catalog {
  const notes: string[] = [];
  const tables: TableMeta[] = [];
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];

  for (const { name } of names) {
    const columnRows = db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {
      cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }[];
    const columns: ColumnMeta[] = columnRows.map((row) => ({
      name: row.name,
      dataType: row.type || 'TEXT',
      notNull: row.notnull === 1,
      primaryKey: row.pk > 0,
      position: row.cid,
      defaultValue: row.dflt_value,
    }));

    const foreignKeys = (db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as {
      table: string; from: string; to: string;
    }[]).map((row) => ({ column: row.from, refTable: row.table, refColumn: row.to }));

    const indexes: TableMeta['indexes'] = [];
    const indexRows = db.prepare(`PRAGMA index_list(${quote(name)})`).all() as {
      name: string; unique: number; origin: string;
    }[];
    for (const index of indexRows) {
      const info = db.prepare(`PRAGMA index_info(${quote(index.name)})`).all() as { name: string }[];
      indexes.push({ name: index.name, columns: info.map((i) => i.name), unique: index.unique === 1 });
    }

    let rowCount = 0;
    try {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get() as { n: number };
      rowCount = Number(count.n);
    } catch (error) {
      notes.push(`cannot count ${name}: ${(error as Error).message}`);
    }

    tables.push({
      name,
      columns,
      primaryKey: columns.filter((c) => c.primaryKey).map((c) => c.name),
      indexes,
      foreignKeys,
      rowCount,
    });
  }

  return { source, fetchedAt: new Date(0).toISOString(), tables, notes };
}

/** The query runner over one SQLite database: read-only by construction (see the guard it is paired with). */
export function sqliteRunner(db: DatabaseSync, options: { rowLimit: number; timeoutMs: number }): QueryRunner {
  return (sql: string): QueryResult => {
    const started = performance.now();
    const statement = db.prepare(sql);
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    const columns: string[] = statement.columns?.().map((c: { name: string }) => c.name) ?? [];
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      if (rows.length >= options.rowLimit) {
        truncated = true;
        break;
      }
      rows.push({ ...row });
    }
    const durationMs = performance.now() - started;
    if (durationMs > options.timeoutMs) {
      throw new Error(`query exceeded ${options.timeoutMs} ms (${Math.round(durationMs)} ms)`);
    }
    return { columns, rows, rowCount: rows.length, truncated, durationMs: Math.round(durationMs * 1000) / 1000 };
  };
}

export function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
