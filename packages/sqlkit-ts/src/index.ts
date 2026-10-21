/**
 * The SQL reader PhoenixAgent uses until the Python `sqlkit` sidecar lands in P2.
 *
 * The sidecar (sqlglot) is the plan for P2's *rewriting* work: dialect transpilation, predicate pushdown,
 * column pruning. P1 only needs to *read* DDL and report SQL, and that is small enough to do in-process,
 * which keeps extraction free of a second runtime. Both implementations answer the same shapes below, so
 * swapping one for the other is a config change - that is what `packages/sqlkit` will be.
 */

export { tokenize, splitStatements, KEYWORDS, isKeyword, isName, splitTokens } from './tokenize.ts';
export type { Token } from './tokenize.ts';
export { parseDdl } from './ddl.ts';
export type { DdlTable, DdlColumn, DdlIndex, DdlParseResult } from './ddl.ts';
export { analyzeSql, analyzeSelect } from './select.ts';
export type { SelectAnalysis, SelectProjection, AggFunction } from './select.ts';
