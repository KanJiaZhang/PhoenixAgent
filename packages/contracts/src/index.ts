/**
 * The vocabulary every module of PhoenixAgent shares.
 *
 * There is one rule behind this file: a semantic-layer fact is only usable if you can say where it came
 * from and how sure you are. So {@link Candidate} carries its {@link Evidence} list and its
 * {@link Provenance}, a relation is an id-shaped triple (`from|relation|to`), and a metric that cannot
 * point at its columns is not a metric. The same shapes are what the review queue edits and what the
 * publisher writes into PhoenixGraph, so the graph and the review log cannot describe two different models.
 */

/** What a semantic node is. The first five are the vocabulary PhoenixGraph's model loader reads. */
export type EntityType = 'table' | 'column' | 'metric' | 'dimension' | 'query' | 'doc' | 'domain';

/**
 * Relations the product needs, not just the ones the graph already had.
 *
 * `contains`/`partOf` are structure, `references` is a join, `groupedBy` is what a metric may be sliced
 * by, `usesColumn`/`computedFrom` are lineage, `definedBy` is the reference query a metric came from,
 * `contributesTo` is the attribution edge (which driver explains which outcome), and `governedBy` /
 * `synonymOf` are the two the docs add: which standard defines it, and which words mean the same node.
 */
export type RelationType =
  | 'contains'
  | 'partOf'
  | 'references'
  | 'groupedBy'
  | 'computedFrom'
  | 'usesColumn'
  | 'dimensionColumn'
  | 'definedBy'
  | 'contributesTo'
  | 'governedBy'
  | 'synonymOf'
  // --- added in P1.5: the relations a model needs to be *usable*, not just readable
  /** domain -> metric/dimension: which business domain a thing belongs to (routing, governance). */
  | 'belongsTo'
  /** domain -> metric: the domain's short list of headline metrics. */
  | 'hasMetric'
  /** dimension level -> coarser level (`day -> month -> quarter -> year`). */
  | 'hierarchy'
  /** view -> table it reads; a derived entity, so "which table answers this" stays answerable. */
  | 'derivedFrom'
  /** ETL/report query -> the table it writes. Lineage in the direction the warehouse actually moves. */
  | 'writes';

/** Where a candidate came from. `parser` is deterministic, `llm` is not, `human` outranks both. */
export type Provenance = 'parser' | 'llm' | 'human' | 'catalog';

/** One traceable source. `span` is a character range in the source file, so a reviewer can jump to it. */
export interface Evidence {
  kind: 'ddl' | 'etl' | 'wiki' | 'pdf' | 'catalog' | 'human';
  /** File id relative to the fixture root, e.g. `wiki/投放口径.md`. */
  sourceFile: string;
  /** Character offsets in the *source file*, half-open: `[start, end)`. */
  span?: [number, number];
  /** The exact text the claim rests on, copied out of the source. */
  quote: string;
  /** Statement index inside a SQL file, when the source is a SQL file. */
  statement?: number;
}

/** A metric's definition, the part that is not its name. */
export interface MetricPayload {
  name: string;
  /** The SQL aggregation expression, physical columns table-qualified: `SUM(fact_ad_daily.spend)`. */
  expression: string;
  aggFunction: 'SUM' | 'COUNT' | 'COUNT_DISTINCT' | 'AVG' | 'MIN' | 'MAX' | 'RATIO';
  metricKind: 'base' | 'ratio' | 'derived';
  /** For a ratio: the two expressions whose quotient is the metric. Empty otherwise. */
  formula?: { numerator: string; denominator: string };
  unit?: string;
  description?: string;
  /** 口径 filters that are part of the definition, e.g. `status = 'paid'`. */
  filters?: string[];
  /** Tables the expression reads. */
  tables: string[];
  /** Columns the expression reads, as `table.column`. */
  columns: string[];
  /** The business domain, when a document declares one. */
  domain?: string;
  /** True when the metric's slices add up to its total; unknown when not measured. */
  additive?: boolean;
  /**
   * Two fact tables, each aggregated at its own grain, then combined. The sides are metric ids, so the SQL is
   * two subqueries joined on the dimensions both sides share - never a join between the facts.
   */
  crossFact?: { numerator: string; denominator: string };
  /** Alternative names from documents and people: the vocabulary a question may use. */
  alias?: string[];
}

/** A column's definition. */
export interface ColumnPayload {
  name: string;
  table: string;
  dataType: string;
  columnRole: 'PK' | 'FK' | 'measure' | 'attribute';
  description?: string;
  alias?: string[];
  /** The fact-graph property that carries this column, when one is declared. */
  graphProperty?: string;
  // --- profiling, added in P1.5: measured facts about the column, not claims about it
  /** True when the column is part of its table's grain (primary key). */
  isGrain?: boolean;
  /** Measured distinct count and null rate, when a profile was taken. */
  cardinality?: number;
  nullRate?: number;
  /** Up to five most frequent values, for a low-cardinality column. */
  topValues?: { value: unknown; count: number }[];
  /** Data-protection classification, from column naming plus a declared policy. */
  sensitivity?: 'pii' | 'financial' | null;
}

/** A table's definition. */
export interface TablePayload {
  name: string;
  description?: string;
  alias?: string[];
  /** The columns that identify one row: what makes "sum of slices" mean what it says. */
  grain?: string[];
  /** The business domain the table serves, when a document declares one. */
  domain?: string;
  /** Measured row count, when a profile was taken. */
  rowCount?: number;
}

/** A dimension's definition: a column a metric can be sliced by. */
export interface DimensionPayload {
  name: string;
  /** The column id it slices by, e.g. `column/fact_ad_daily.region_id`. */
  column?: string;
  description?: string;
  alias?: string[];
  dataType?: string;
  /**
   * A SQL expression over the column when the level is not the column itself: `month` over a date is
   * `substr(date_key, 1, 7)`. Without this a time hierarchy is not expressible.
   */
  expression?: string;
  /** The level name in a hierarchy: `day`, `month`, `quarter`, `year`. */
  level?: string;
  /** Measured distinct count, so a "dimension" that is really an id can be told apart from a category. */
  cardinality?: number;
}

/**
 * One candidate fact, before anybody has accepted it.
 *
 * `status` is the human-in-the-loop switch: `candidate` is what the extractors emit, `needs_review` is
 * what the pipeline raises when a probe failed or two sources disagreed, `accepted`/`rejected` are
 * decisions. A rejected candidate stays in the log - the review history is the audit trail.
 */
export interface Candidate {
  /** Semantic id: `table/x`, `column/t.c`, `metric/m`, `dim/d`, `query/q`. */
  id: string;
  kind: 'entity' | 'relation';
  entityType?: EntityType;
  /** For a relation: the triple. `id` is `${from}|${relationType}|${to}`. */
  from?: string;
  to?: string;
  relationType?: RelationType;
  payload: MetricPayload | ColumnPayload | TablePayload | DimensionPayload | Record<string, unknown>;
  provenance: Provenance;
  confidence: number;
  evidence: Evidence[];
  status: 'candidate' | 'accepted' | 'rejected' | 'needs_review';
  /** Why the pipeline raised it for review, or why it was rejected. Free text, shown to the reviewer. */
  note?: string;
  /** Set when two sources disagree about the same id. */
  conflict?: string;
}

/** One probe execution. A probe either passes, is weak (usable but flagged), fails or cannot run. */
export interface ProbeResult {
  /** `existence:<id>` / `references:<id>` / `groupedBy:<id>` / `golden:<id>` / `formula:<id>`. */
  id: string;
  probe: 'existence' | 'references' | 'groupedBy' | 'golden' | 'formula' | 'grain' | 'enum';
  target: string;
  status: 'pass' | 'weak' | 'fail' | 'error' | 'skipped';
  /** The measured number the verdict rests on (match rate, relative error, ...). */
  value?: number;
  threshold?: number;
  detail: string;
  sql?: string;
  durationMs?: number;
}

/** Per-type tally. `accuracy` is null when nothing in this class was probed - reported, never guessed. */
export interface Tally {
  total: number;
  probed: number;
  passed: number;
  weak: number;
  failed: number;
  accuracy: number | null;
}

/**
 * The report the gate reads.
 *
 * `gate.passed` is the only thing that lets `publish` bump the model version; everything else is there so
 * a person can see *which* claim is weak instead of trusting a single number.
 */
export interface QualityReport {
  graph: string;
  modelVersion: number;
  generatedAt: string;
  sourceFiles: { kind: string; path: string }[];
  entities: Record<string, Tally>;
  relations: Record<string, Tally>;
  coverage: {
    tables: number;
    columns: number;
    columnsDocumented: number;
    metricsWithDefinition: number;
    dimensions: number;
    joinPairs: number;
    joinPairsValidated: number;
  };
  /**
   * Per-table completeness, because "84% of columns documented" hides the fact that one table is 20% and
   * another is 100%. A table's score is the four things a table needs to be usable: documented, keyed,
   * connected, and measured by something.
   */
  completeness: { table: string; score: number; missing: string[] }[];
  /** How many relations of each type the model has - the ontology's own coverage. */
  relationInventory: Record<string, number>;
  /** What changed since the previous build of the same graph, when there was one. */
  drift?: { added: string[]; removed: string[]; changed: string[] };
  /** Tables with no relation and no metric: they exist in the warehouse but mean nothing to anyone yet. */
  orphans: string[];
  gate: { passed: boolean; reasons: string[] };
  probes: ProbeResult[];
  conflicts: string[];
  notes: string[];
}

/** One review action. Append-only: replaying the log reproduces any past state. */
export interface Revision {
  revision: number;
  ts: string;
  actor: string;
  action: 'accept' | 'reject' | 'edit' | 'add' | 'resolve-conflict' | 'publish';
  target: string;
  reason: string;
  /** For `edit`/`add`: the fields that changed, or the candidate that was added. */
  patch?: Record<string, unknown>;
}

export const ENTITY_PREFIX: Record<EntityType, string> = {
  table: 'table/',
  column: 'column/',
  metric: 'metric/',
  dimension: 'dim/',
  query: 'query/',
  doc: 'doc/',
  domain: 'domain/',
};

/** `metric/GMV 率` -> `metric/gmv-率`; ids must survive being a graph key. */
export function slug(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._\-\u4e00-\u9fff]/gu, '')
    .toLowerCase();
}

export function domainId(name: string): string {
  return `domain/${slug(name)}`;
}

export function metricId(name: string): string {
  return `metric/${slug(name)}`;
}

export function dimId(name: string): string {
  return `dim/${slug(name)}`;
}

export function tableId(name: string): string {
  return `table/${slug(name)}`;
}

export function columnId(table: string, column: string): string {
  return `column/${slug(table)}.${slug(column)}`;
}

export function relationId(from: string, relation: RelationType, to: string): string {
  return `${from}|${relation}|${to}`;
}

/** The short name of a semantic id: `column/a.b` -> `a.b`, `metric/x` -> `x`. */
export function shortId(id: string): string {
  const slash = id.indexOf('/');
  return slash < 0 ? id : id.slice(slash + 1);
}

/** The table part of a column id: `column/fact_ad_daily.spend` -> `fact_ad_daily`. */
export function tableOfColumn(id: string): string {
  const name = shortId(id);
  const dot = name.indexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}
