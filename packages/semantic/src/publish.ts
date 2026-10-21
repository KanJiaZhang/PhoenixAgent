/**
 * Publishing: the model becomes graph data, and the graph is read back to prove it.
 *
 * ## The one constraint this file is shaped by
 *
 * PhoenixGraph has two kinds of graph and they do not overlap:
 *
 * - the **analytical** scheme (RocksDB-Edge) answers `g.V('Node')` - a scan of a whole type - and that is
 *   exactly what the base's semantic loader does. But a RocksDB graph is *loaded*, never written over REST
 *   (`GraphService.forGraph` refuses it by name).
 * - the **keyed** scheme (Aerospike) accepts writes and point reads, and *refuses* type scans
 *   ("a keyed store answers by id").
 *
 * So "publish, then call `/semantic/{graph}/model`" cannot be one step. P1 therefore does the honest two:
 *
 * 1. **writes the keyed copy** - every node and edge, read back by id and compared, which is the strongest
 *    check a keyed store can support and is enough to prove nothing was lost or mistyped;
 * 2. **exports the analytical copy** - the same model as a `Node`/`Relation` graph document plus its schema,
 *    saved as `v<N>.graph.json`, for the RocksDB load path that the base's semantic reader needs.
 *
 * That split is written down in `docs/P1-NOTES.md` rather than hidden in a comment, because it is a
 * deployment fact somebody will hit: the agent reads the keyed copy by id, the SQL renderer reads the
 * analytical copy by scan, and both come from one publish.
 *
 * ## Two details that are easy to get wrong
 *
 * - **Property indexes come from the schema, not from this file.** The write API addresses properties by the
 *   id the schema assigned, so the schema is read back and the indexes looked up by name.
 * - **Vertices before edges.** An edge whose endpoint does not exist is refused (404 naming it), so the write
 *   order is part of the contract.
 */

import {
  type Candidate,
  type RelationType,
} from '../../contracts/src/index.ts';
import type { GraphClient, GraphVertexProperty, SchemaDraft, StoredSchema } from '../../core/src/graph-client.ts';
import type { MergedCandidate } from './merge.ts';

const VERTEX_PROPERTIES: { name: string; type: string; description: string }[] = [
  { name: 'name', type: 'string', description: 'Node id (table/column/metric/dimension/query), the value edges point at' },
  { name: 'entityType', type: 'string', description: 'Table / Column / Metric / Dimension / Query' },
  { name: 'description', type: 'string', description: 'Business meaning (来自 DDL 注释、文档或人工)' },
  { name: 'alias', type: 'list<string>', description: 'Alternative names (多值)' },
  { name: 'dataType', type: 'string', description: 'Column SQL type' },
  { name: 'columnRole', type: 'string', description: 'PK / FK / measure / attribute' },
  { name: 'tableName', type: 'string', description: 'The table a column belongs to' },
  { name: 'aggFunction', type: 'string', description: 'SUM / COUNT / COUNT_DISTINCT / AVG / RATIO' },
  { name: 'expression', type: 'string', description: 'The SQL aggregation expression (the metric definition)' },
  { name: 'metricKind', type: 'string', description: 'base / ratio / derived' },
  { name: 'unit', type: 'string', description: 'Unit (元 / 个 / %)' },
  { name: 'sqlText', type: 'string', description: 'The SQL of a reference query' },
  { name: 'graphProperty', type: 'string', description: 'The fact-graph property that carries this column' },
  // --- the review state, so the graph itself says what has been checked and by whom
  { name: 'status', type: 'string', description: 'candidate / accepted / needs_review / rejected' },
  { name: 'confidence', type: 'double', description: 'Extraction confidence (0..1)' },
  { name: 'proposedBy', type: 'string', description: 'parser / llm / human' },
  { name: 'evidence', type: 'string', description: 'JSON: the sources this node rests on, with character spans' },
  { name: 'revision', type: 'long', description: 'The model revision this node was published in' },
];

const EDGE_PROPERTIES: { name: string; type: string; description: string }[] = [
  { name: 'relation', type: 'string', description: 'Relation name (contains / references / groupedBy / ...)' },
  { name: 'xrelation', type: 'string', description: 'Reverse relation name' },
  { name: 'relationLabel', type: 'string', description: '中文关系名' },
  { name: 'relationFamily', type: 'string', description: '关系家族 (结构 / 血缘 / 关联 / 指标 / 归因)' },
  { name: 'confidence', type: 'double', description: 'Confidence of this edge' },
  { name: 'evidence', type: 'string', description: 'JSON: where the edge came from' },
  { name: 'status', type: 'string', description: 'candidate / accepted / needs_review' },
];

const RELATION_META: Record<string, { inverse: string; label: string; family: string }> = {
  contains: { inverse: 'partOf', label: '包含', family: '结构' },
  partOf: { inverse: 'contains', label: '属于', family: '结构' },
  references: { inverse: 'references', label: '外键引用', family: '关联' },
  groupedBy: { inverse: 'sliceOf', label: '可按维度切片', family: '指标' },
  computedFrom: { inverse: 'feeds', label: '取自表', family: '血缘' },
  usesColumn: { inverse: 'usedBy', label: '使用字段', family: '血缘' },
  dimensionColumn: { inverse: 'dimensionOf', label: '维度字段', family: '指标' },
  definedBy: { inverse: 'defines', label: '定义自查询', family: '指标' },
  contributesTo: { inverse: 'drivenBy', label: '贡献因子', family: '归因' },
  governedBy: { inverse: 'governs', label: '由文档约定', family: '治理' },
  synonymOf: { inverse: 'synonymOf', label: '同义词', family: '治理' },
  belongsTo: { inverse: 'hasMember', label: '属于业务域', family: '治理' },
  hasMetric: { inverse: 'belongsTo', label: '域内指标', family: '治理' },
  hierarchy: { inverse: 'rollsUpTo', label: '层级上卷', family: '结构' },
  derivedFrom: { inverse: 'derivedInto', label: '读取自', family: '血缘' },
  writes: { inverse: 'writtenBy', label: '写入表', family: '血缘' },
};

const ENTITY_LABEL: Record<string, string> = {
  table: 'Table',
  column: 'Column',
  metric: 'Metric',
  dimension: 'Dimension',
  query: 'Query',
  domain: 'Domain',
};

export interface PublishCheck {
  vertexReads: number;
  edgeReads: number;
  failures: string[];
}

export interface PublishResult {
  graph: string;
  vertices: number;
  edges: number;
  /** Nodes and edges carried over from the previous revision as `status: rejected`. */
  tombstoned: number;
  schemaCreated: boolean;
  checks: PublishCheck;
}

export function buildSchemaDraft(graph: string, storage = 'Aerospike'): SchemaDraft {
  return {
    name: graph,
    description: 'PhoenixAgent semantic layer: tables, columns, metrics, dimensions and the relations between them',
    idType: 'string',
    storage: { type: storage },
    vertices: [{
      name: 'Node',
      description: 'A semantic-layer node: Table / Column / Metric / Dimension / Query',
      display: 'name',
      properties: VERTEX_PROPERTIES,
    }],
    edges: [{
      name: 'Relation',
      description: 'A semantic-layer relation: structural, lineage, join, metric or attribution',
      direction: 'DIRECTED',
      source: 'Node',
      target: 'Node',
      properties: EDGE_PROPERTIES,
    }],
  };
}

export interface PublishPayload {
  vertices: { id: string; vertexSchemaName: string; properties: GraphVertexProperty[] }[];
  edges: {
    edgeId: string; edgeSchemaName: string; source: string; destination: string; properties: GraphVertexProperty[];
  }[];
}

/** The payload, with property *names* still attached, so the export can be read by a person. */
function buildPayload(candidates: MergedCandidate[], vertexIndex: Map<string, number>,
  edgeIndex: Map<string, number>, revision: number): PublishPayload {
  const live = candidates.filter((candidate) => candidate.status !== 'rejected');
  const vertices = live
    .filter((candidate) => candidate.kind === 'entity')
    .map((candidate) => ({
      id: candidate.id,
      vertexSchemaName: 'Node',
      properties: toProperties(vertexValues(candidate, revision), vertexIndex),
    }));

  const vertexIds = new Set(vertices.map((vertex) => vertex.id));
  const edges = live
    .filter((candidate) => candidate.kind === 'relation')
    .filter((candidate) => vertexIds.has(candidate.from!) && vertexIds.has(candidate.to!))
    .map((candidate) => ({
      edgeId: candidate.id,
      edgeSchemaName: 'Relation',
      source: candidate.from!,
      destination: candidate.to!,
      properties: toProperties(edgeValues(candidate), edgeIndex),
    }));

  return { vertices, edges };
}

export async function publish(
  client: GraphClient,
  options: {
    graph: string;
    candidates: MergedCandidate[];
    revision: number;
    /**
     * The previous revision's candidates, so what this one dropped can be tombstoned.
     *
     * A keyed store cannot scan, and the node ids contain `/` (`metric/gmv`), which an HTTP path cannot carry
     * to the delete endpoint. So a dropped node is not deleted: it is **rewritten with `status: 'rejected'`**,
     * the same way the base itself treats a delete as a marker. The graph therefore keeps the history of what
     * was published and later withdrawn, and every reader filters `rejected` out.
     */
    previousCandidates?: MergedCandidate[];
    log?: (line: string) => void;
  },
): Promise<PublishResult> {
  const log = options.log ?? (() => {});

  // --- 1. the schema, and the property ids
  //
  // The ids are known without asking the server: the draft declares the properties in a fixed order and the
  // service assigns index = position (1-based) within each element type. Reading the stored schema back is a
  // *cross-check*, not the source - and it is optional, because a graph created at runtime is served from
  // memory and `GET /schema/{graph}` answers 404 for it (it reads the file the loader wrote, not the registry).
  // Relying on that endpoint made the second publish of a session fail with "already served"; the read-back
  // verification below is what actually proves the write, so the ids are derived and then compared when the
  // server does answer.
  const existing = await client.storedSchema(options.graph);
  let schemaCreated = false;

  // A schema *file* on disk is not a served graph: after a base restart the file may still be there while the
  // graph is not registered, and then every write fails with "unknown graph". So the check is "is it served",
  // and if not it is (re)registered with replace=true - which overwrites the stale file and registers it.
  if (!(await client.served(options.graph))) {
    log(`registering '${options.graph}' with the base (Aerospike, keyed)`);
    try {
      await client.saveSchema(buildSchemaDraft(options.graph), true);
      schemaCreated = true;
    } catch (error) {
      if (!/already served/.test((error as Error).message)) throw error;
    }
    if (!(await client.served(options.graph))) {
      throw new Error(`the base accepted the schema for '${options.graph}' but does not serve it; `
        + 'check the base log (a schema file can exist without the graph being registered)');
    }
  }

  const vertexIndex = declaredIndex(VERTEX_PROPERTIES);
  const edgeIndex = declaredIndex(EDGE_PROPERTIES);
  if (existing) crossCheckIndex(existing, 'Node', 'vertex', vertexIndex, options.graph);
  if (existing) crossCheckIndex(existing, 'Relation', 'edge', edgeIndex, options.graph);
  const payload = buildPayload(options.candidates, vertexIndex, edgeIndex, options.revision);

  // --- 2. tombstone what the previous revision had and this one does not
  const tombstones = buildTombstones(options.previousCandidates ?? [], options.candidates,
    vertexIndex, edgeIndex, options.revision);
  payload.vertices.push(...tombstones.vertices);
  payload.edges.push(...tombstones.edges);
  if (tombstones.vertices.length + tombstones.edges.length > 0) {
    log(`tombstoned ${tombstones.vertices.length} node(s) and ${tombstones.edges.length} edge(s) the new revision dropped`);
  }

  // --- 3. write
  const written = await client.batchWrite(options.graph, payload);
  const failed = [...written.vertices, ...written.edges].filter((result) => !/SUCCESS/.test(result.status));
  if (failed.length > 0) {
    throw new Error(`${failed.length} write(s) did not succeed: ${JSON.stringify(failed.slice(0, 3))}`);
  }

  // --- 4. read it back by id: the check a keyed store can actually pass
  const checks = await verify(client, options.graph, payload, log);
  return {
    graph: options.graph,
    vertices: payload.vertices.length,
    edges: payload.edges.length,
    tombstoned: tombstones.vertices.length + tombstones.edges.length,
    schemaCreated,
    checks,
  };
}

/**
 * The previous model minus the current one, written as `status: rejected`.
 *
 * Edges are tombstoned too, and a tombstone edge whose endpoints are both tombstoned is skipped - a relation
 * between two withdrawn nodes is not history anybody can use.
 */
function buildTombstones(previous: MergedCandidate[], current: MergedCandidate[], vertexIndex: Map<string, number>,
  edgeIndex: Map<string, number>, revision: number): PublishPayload {
  const currentVertices = new Set(current.filter((c) => c.kind === 'entity' && c.status !== 'rejected').map((c) => c.id));
  const currentEdges = new Set(current.filter((c) => c.kind === 'relation' && c.status !== 'rejected').map((c) => c.id));
  const dropped = previous.filter((candidate) => candidate.status !== 'rejected'
    && (candidate.kind === 'entity' ? !currentVertices.has(candidate.id) : !currentEdges.has(candidate.id)));

  const droppedVertices = dropped.filter((candidate) => candidate.kind === 'entity');
  const droppedEdges = dropped.filter((candidate) => candidate.kind === 'relation');
  const tombstoneIds = new Set(droppedVertices.map((candidate) => candidate.id));

  return {
    vertices: droppedVertices.map((candidate) => ({
      id: candidate.id,
      vertexSchemaName: 'Node',
      properties: toProperties({ ...vertexValues(candidate, revision), status: 'rejected' }, vertexIndex),
    })),
    edges: droppedEdges
      .filter((candidate) => !(tombstoneIds.has(candidate.from!) && tombstoneIds.has(candidate.to!)))
      .map((candidate) => ({
        edgeId: candidate.id,
        edgeSchemaName: 'Relation',
        source: candidate.from!,
        destination: candidate.to!,
        properties: toProperties({ ...edgeValues(candidate), status: 'rejected' }, edgeIndex),
      })),
  };
}

/**
 * Reads every node back by id and one edge list per node family.
 *
 * `g.V('Node')` is refused on a keyed store, so the check is the other way round: name the ids and compare
 * what comes back. Every node is read (they are cheap point reads), every edge's endpoints are read, and a
 * sample of edge traversals is compared against the payload - enough to catch a dropped property, a missing
 * edge, or a relation property that never landed.
 */
async function verify(client: GraphClient, graph: string, payload: PublishPayload,
  log: (line: string) => void): Promise<PublishCheck> {
  const failures: string[] = [];
  let vertexReads = 0;
  let edgeReads = 0;

  for (const vertex of payload.vertices) {
    const rows = await client.query(graph, `g.V('${escapeId(vertex.id)}','Node').elementMap()`);
    vertexReads++;
    if (rows.length === 0) {
      failures.push(`${vertex.id} was written but cannot be read back`);
      continue;
    }
    const row = rows[0] as Record<string, unknown>;
    const name = String(row.name ?? '');
    if (name !== vertex.id) failures.push(`${vertex.id} came back named '${name}'`);
  }

  // edge traversals, one per (source, relation) family, capped so a big model stays a fast publish
  // one sample per (source, relation): the edge id is `from|relation|to`, so the relation needs no lookup
  const samples = new Map<string, PublishPayload['edges'][number]>();
  for (const edge of payload.edges) {
    const key = `${edge.source}|${edge.edgeId.split('|')[1] ?? ''}`;
    if (!samples.has(key)) samples.set(key, edge);
  }
  for (const edge of [...samples.values()].slice(0, 40)) {
    const relation = edge.edgeId.split('|')[1];
    const rows = await client.query(graph,
      `g.V('${escapeId(edge.source)}','Node').outE().filter(relation.equals('${relation}')).otherV().values('name')`);
    edgeReads++;
    const names = rows.map((row) => (typeof row === 'string' ? row : String((row as { value?: unknown }).value ?? JSON.stringify(row))));
    if (!names.some((name) => name.includes(edge.destination))) {
      failures.push(`edge ${edge.edgeId} is not traversable from ${edge.source}`);
    }
  }

  if (failures.length > 0) {
    log(`${failures.length} read-back failure(s)`);
    for (const failure of failures.slice(0, 5)) log(`  - ${failure}`);
  }
  return { vertexReads, edgeReads, failures };
}

function escapeId(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** The ids the service will assign: declaration order, starting at 1, per element type. */
function declaredIndex(properties: { name: string }[]): Map<string, number> {
  return new Map(properties.map((property, index) => [property.name, index + 1]));
}

/** When the server can show its schema, the declared ids must be the ones it actually stored. */
function crossCheckIndex(stored: StoredSchema, schemaName: string, kind: 'vertex' | 'edge',
  declared: Map<string, number>, graph: string): void {
  const schemas = kind === 'vertex' ? stored.vertexSchemas : stored.edgeSchemas;
  const schema = schemas.find((entry) => entry.name === schemaName);
  if (!schema) return;
  for (const property of schema.properties) {
    const expected = declared.get(property.name);
    if (expected !== undefined && expected !== property.id) {
      throw new Error(`graph '${graph}': property '${property.name}' is id ${property.id} in the served schema but `
        + `${expected} by declaration; the model was written by a different schema version`);
    }
  }
}

function vertexValues(candidate: MergedCandidate, revision: number): Record<string, unknown> {
  const payload = candidate.payload as Record<string, unknown>;
  return {
    name: candidate.id,
    entityType: ENTITY_LABEL[candidate.entityType ?? ''] ?? 'Node',
    description: payload.description,
    alias: Array.isArray(payload.alias) ? payload.alias : undefined,
    dataType: payload.dataType,
    columnRole: payload.columnRole,
    tableName: payload.table,
    aggFunction: payload.aggFunction,
    expression: payload.expression,
    metricKind: payload.metricKind,
    unit: payload.unit,
    sqlText: payload.sqlText,
    graphProperty: payload.graphProperty,
    status: candidate.status,
    confidence: candidate.confidence,
    proposedBy: candidate.provenance,
    evidence: JSON.stringify(candidate.evidence.map((item) => ({
      kind: item.kind,
      sourceFile: item.sourceFile,
      span: item.span,
      quote: item.quote.slice(0, 300),
    }))).slice(0, 64 * 1024),
    revision,
  };
}

function edgeValues(candidate: MergedCandidate): Record<string, unknown> {
  const relation = candidate.relationType as RelationType;
  const meta = RELATION_META[relation] ?? { inverse: relation, label: relation, family: '其他' };
  return {
    relation,
    xrelation: meta.inverse,
    relationLabel: meta.label,
    relationFamily: meta.family,
    confidence: candidate.confidence,
    evidence: JSON.stringify(candidate.evidence.map((item) => ({
      sourceFile: item.sourceFile,
      span: item.span,
      quote: item.quote.slice(0, 300),
    }))),
    status: candidate.status,
  };
}

function toProperties(values: Record<string, unknown>, index: Map<string, number>): GraphVertexProperty[] {
  const out: GraphVertexProperty[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    const propertyIndex = index.get(name);
    if (propertyIndex === undefined) continue;
    out.push({ index: propertyIndex, value });
  }
  return out;
}

/**
 * The analytical copy: the `Node`/`Relation` graph a RocksDB-Edge deployment loads.
 *
 * It carries the schema too, because the loader needs it and because a model exported without its schema is
 * a pile of JSON somebody has to reconstruct property indexes from.
 */
export function exportAnalytical(graph: string, candidates: MergedCandidate[], revision: number): {
  schema: SchemaDraft;
  vertices: { id: string; type: string; properties: Record<string, unknown> }[];
  edges: { id: string; type: string; source: string; target: string; properties: Record<string, unknown> }[];
  revision: number;
} {
  const live = candidates.filter((candidate) => candidate.status !== 'rejected');
  return {
    schema: buildSchemaDraft(graph, 'RocksDB-Edge'),
    revision,
    vertices: live
      .filter((candidate) => candidate.kind === 'entity')
      .map((candidate) => ({ id: candidate.id, type: 'Node', properties: vertexValues(candidate, revision) })),
    edges: live
      .filter((candidate) => candidate.kind === 'relation')
      .map((candidate) => ({
        id: candidate.id,
        type: 'Relation',
        source: candidate.from!,
        target: candidate.to!,
        properties: edgeValues(candidate),
      })),
  };
}

/** The semantic ids a revision contains, for the next publish's cleanup. */
export function candidateIds(candidates: Candidate[]): string[] {
  return candidates.filter((candidate) => candidate.kind === 'entity' && candidate.status !== 'rejected')
    .map((candidate) => candidate.id);
}
