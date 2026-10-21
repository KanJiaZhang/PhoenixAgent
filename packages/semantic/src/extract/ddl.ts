/**
 * Extracts the semantic layer's structure from DDL.
 *
 * This reader is the only one that is *certain*: no model, no guessing. What it can be wrong about is the
 * meaning, and it does not claim any: the description comes from the `COMMENT` the author wrote, and when
 * there is none the field stays empty and the report counts it as an undocumented column. That is the
 * intended behaviour - a generated-sounding description is worse than a blank one, because the blank one
 * makes somebody look.
 *
 * Column roles are decided here too, because `columnRole` is what makes an FK a join path later:
 * PK for primary keys, FK for declared foreign keys, `measure` for numerics that are neither, `attribute`
 * for the rest. A wrong role is visible in the model, and the reference probes are what keeps it honest.
 */

import { parseDdl } from '../../../sqlkit-ts/src/ddl.ts';
import {
  columnId,
  relationId,
  tableId,
  type Candidate,
  type ColumnPayload,
  type Evidence,
  type TablePayload,
} from '../../../contracts/src/index.ts';

const NUMERIC = new Set([
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'NUMERIC', 'NUMBER', 'FLOAT', 'DOUBLE',
  'REAL', 'MONEY', 'LONG',
]);

export interface DdlExtraction {
  candidates: Candidate[];
  notes: string[];
}

/** Reads one DDL file into table/column entities plus `contains` and `references` relations. */
export function extractFromDdl(sourceFile: string, sql: string): DdlExtraction {
  const parsed = parseDdl(sql);
  const candidates: Candidate[] = [];
  const notes = parsed.notes.map((note) => `${sourceFile}: ${note}`);

  for (const table of parsed.tables) {
    const tableEvidence = evidence(sourceFile, table.span, `CREATE TABLE ${table.name}`);
    const tablePayload: TablePayload = {
      name: table.name,
      description: table.comment,
      alias: [],
    };
    candidates.push({
      id: tableId(table.name),
      kind: 'entity',
      entityType: 'table',
      payload: tablePayload,
      provenance: 'parser',
      confidence: 1,
      evidence: [tableEvidence],
      status: 'candidate',
    });

    const fkColumns = new Set(table.foreignKeys.flatMap((fk) => fk.columns));
    for (const column of table.columns) {
      const role: ColumnPayload['columnRole'] = column.primaryKey
        ? 'PK'
        : fkColumns.has(column.name)
          ? 'FK'
          : NUMERIC.has(column.baseType)
            ? 'measure'
            : 'attribute';
      const payload: ColumnPayload = {
        name: column.name,
        table: table.name,
        dataType: column.dataType,
        columnRole: role,
        description: column.comment,
        alias: [],
      };
      candidates.push({
        id: columnId(table.name, column.name),
        kind: 'entity',
        entityType: 'column',
        payload,
        provenance: 'parser',
        confidence: 1,
        evidence: [evidence(sourceFile, column.span, `${table.name}.${column.name} ${column.dataType}`)],
        status: 'candidate',
      });

      candidates.push({
        id: relationId(tableId(table.name), 'contains', columnId(table.name, column.name)),
        kind: 'relation',
        relationType: 'contains',
        from: tableId(table.name),
        to: columnId(table.name, column.name),
        payload: {},
        provenance: 'parser',
        confidence: 1,
        evidence: [tableEvidence],
        status: 'candidate',
      });
    }

    // --- declared foreign keys become `references`: a claim the probe will test against the data
    for (const fk of table.foreignKeys) {
      for (let i = 0; i < fk.columns.length; i++) {
        const column = fk.columns[i]!;
        const refColumn = fk.refColumns[i] ?? fk.refColumns[0];
        if (!refColumn) continue;
        const from = columnId(table.name, column);
        const to = columnId(fk.refTable, refColumn);
        candidates.push({
          id: relationId(from, 'references', to),
          kind: 'relation',
          relationType: 'references',
          from,
          to,
          payload: { declaredBy: 'FOREIGN KEY' },
          provenance: 'parser',
          confidence: 1,
          evidence: [evidence(sourceFile, fk.span ?? table.span,
            `FOREIGN KEY (${column}) REFERENCES ${fk.refTable} (${refColumn})`)],
          status: 'candidate',
        });
      }
    }
  }

  return { candidates, notes };
}

function evidence(sourceFile: string, span: [number, number] | undefined, quote: string): Evidence {
  return { kind: 'ddl', sourceFile, span, quote };
}
