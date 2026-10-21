/**
 * The only place that speaks HTTP to PhoenixGraph.
 *
 * Three rules, because this file is where a data agent could quietly break its own promises:
 *
 * 1. **The tool catalogue is read, never restated.** `tools()` is what the service says it can do; the
 *    bindings tell us how to call each one. If the base adds a tool, this file needs no change - and it
 *    cannot advertise something the base does not serve.
 * 2. **Errors carry the body.** A 400 from the base names the field it refused; losing that turns "your
 *    schema is wrong" into "something failed".
 * 3. **Publishing is explicit.** `saveSchema` and `batchWrite` are the only write paths, they are named
 *    like the danger they are, and `publish` in the semantic package is the only caller.
 */

import type { Config } from './config.ts';

export class PhoenixGraphError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;
  constructor(message: string, status: number, path: string, body: string) {
    super(message);
    this.name = 'PhoenixGraphError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export interface ToolCatalog {
  tools: { name: string; description: string; parameters: { name: string; type: string; description: string; required?: boolean }[] }[];
  bindings: Record<string, { method: string; path: string }>;
  answerShape?: string;
}

export interface GraphVertexProperty {
  index: number;
  value: unknown;
}

export interface SchemaDraft {
  name: string;
  description: string;
  idType: 'string' | 'long';
  storage?: { type: string } | null;
  vertices: {
    name: string;
    description: string;
    display?: string | null;
    properties: { name: string; type: string; description: string; display?: boolean }[];
  }[];
  edges: {
    name: string;
    description: string;
    direction: 'DIRECTED' | 'UNDIRECTED' | 'BIDIRECTIONAL';
    source: string;
    target: string;
    properties: { name: string; type: string; description: string }[];
  }[];
}

/** The serialized schema the service hands back: property ids are what a write must use. */
export interface StoredSchema {
  name: string;
  vertexSchemas: { name: string; properties: { id: number; name: string }[] }[];
  edgeSchemas: { name: string; properties: { id: number; name: string }[] }[];
}

export interface WriteResult {
  id: unknown;
  status: string;
}

export class GraphClient {
  private readonly config: Config['phoenix'];

  constructor(config: Config['phoenix']) {
    this.config = config;
  }

  // --- reads ---------------------------------------------------------------------------------------

  async health(): Promise<boolean> {
    const response = await this.request('GET', '/api/v1/health');
    return response.ok;
  }

  async tools(): Promise<ToolCatalog> {
    return this.json<ToolCatalog>('GET', '/api/v1/agent/tools');
  }

  /** Calls a catalogued tool by name, translating `{graph}` in the binding path. */
  async callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    const catalog = await this.tools();
    const binding = catalog.bindings[name];
    if (!binding) {
      throw new PhoenixGraphError(`unknown tool '${name}'; the service advertises: ${Object.keys(catalog.bindings).join(', ')}`,
        0, '/api/v1/agent/tools', '');
    }
    const graph = typeof params.graph === 'string' ? params.graph : '';
    const path = binding.path.replace('{graph}', encodeURIComponent(graph));
    if (binding.method === 'GET') {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (key !== 'graph' && value !== undefined) query.set(key, String(value));
      }
      const suffix = query.toString() ? `?${query.toString()}` : '';
      return this.json('GET', `${path}${suffix}`);
    }
    return this.json('POST', path, params);
  }

  async query(graph: string, gremlin: string): Promise<unknown[]> {
    // Two shapes come back depending on `returnSubgraph`: a bare array of rows, or an object carrying
    // `result` next to the drawn subgraph. Both mean "these are the traversers".
    const answer = await this.json<unknown>('POST', '/api/v1/query', {
      graphName: graph,
      query: gremlin,
      includeResult: true,
    });
    if (Array.isArray(answer)) return answer;
    const rows = (answer as { result?: unknown })?.result;
    return Array.isArray(rows) ? rows : [];
  }

  /** The semantic model the base derives from a graph's `Node`/`Relation` data. */
  async semanticModel(graph: string): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>('GET', `/api/v1/semantic/${encodeURIComponent(graph)}/model`);
  }

  /** Whether the base *serves* the graph. A schema file on disk is not the same thing (see publish). */
  async served(graph: string): Promise<boolean> {
    const graphs = await this.json<{ name: string }[]>('GET', '/api/v1/graphs');
    return graphs.some((entry) => entry.name === graph);
  }

  async storedSchema(graph: string): Promise<StoredSchema | null> {
    const response = await this.request('GET', `/api/v1/schema/${encodeURIComponent(graph)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await this.failure('GET', `/api/v1/schema/${graph}`, response);
    return (await response.json()) as StoredSchema;
  }

  // --- writes: only the publisher calls these ------------------------------------------------------

  async saveSchema(draft: SchemaDraft, replace = false): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>('POST', `/api/v1/schema?replace=${replace ? 'true' : 'false'}`, draft);
  }

  /** Writes vertices and edges in chunks the service accepts. Returns per-chunk results. */
  async batchWrite(
    graph: string,
    payload: { vertices: { id: string; vertexSchemaName: string; properties: GraphVertexProperty[] }[];
               edges: { edgeId: string; edgeSchemaName: string; source: string; destination: string; properties: GraphVertexProperty[] }[] },
    chunkSize = 200,
  ): Promise<{ vertices: WriteResult[]; edges: WriteResult[] }> {
    const vertices: WriteResult[] = [];
    const edges: WriteResult[] = [];
    const vertexChunks = chunk(payload.vertices, chunkSize);
    const edgeChunks = chunk(payload.edges, chunkSize);
    for (const slice of vertexChunks) {
      const result = await this.json<WriteResult[]>('POST', `/api/v1/graphs/${encodeURIComponent(graph)}/batch`, { vertices: slice, edges: [] });
      vertices.push(...result);
    }
    for (const slice of edgeChunks) {
      const result = await this.json<WriteResult[]>('POST', `/api/v1/graphs/${encodeURIComponent(graph)}/batch`, { vertices: [], edges: slice });
      edges.push(...result);
    }
    return { vertices, edges };
  }

  async deleteVertex(graph: string, id: string): Promise<void> {
    await this.json('DELETE', `/api/v1/graphs/${encodeURIComponent(graph)}/vertices/${encodeURIComponent(id)}`);
  }

  // --- plumbing ------------------------------------------------------------------------------------

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    if (!response.ok) throw await this.failure(method, path, response);
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : null) as T;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async failure(method: string, path: string, response: Response): Promise<PhoenixGraphError> {
    const body = await response.text().catch(() => '');
    return new PhoenixGraphError(`${method} ${path} answered ${response.status}: ${body.slice(0, 600)}`,
      response.status, path, body);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
