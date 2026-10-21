/**
 * M8: one HTTP surface for the seven tools, with roles, an audit trail, and a console.
 *
 * The design constraint is that **the catalogue is generated from the routes**. `/v1/tools` is built by walking
 * the same table the dispatcher uses, so a tool cannot be advertised without a handler, and the MCP server
 * (which reads that catalogue) cannot drift from the service. That is the same rule the base applies to its own
 * 13 tools, kept here on purpose.
 *
 * What the endpoints are *not*: a second implementation. Every handler calls the module the CLI calls - the
 * semantic pipeline, the attribution loop, the campaign agent, the risk agent, the SQL workspace, the skill
 * store. The API adds three things and only three: authentication/roles, the confirm-token gate for plans, and
 * an audit line per request.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../../core/src/config.ts';
import { GraphClient, PhoenixGraphError } from '../../core/src/graph-client.ts';
import { appendJsonl, readJson, readJsonl } from '../../core/src/workspace.ts';
import { route } from '../../core/src/router.ts';
import { assertReadOnly } from '../../dataplane/src/guard.ts';
import { readSqliteCatalog, sqliteRunner, type QueryRunner } from '../../dataplane/src/sqlite.ts';
import { indexModel, type ModelIndex } from '../../semantic/src/sql.ts';
import type { MergedCandidate } from '../../semantic/src/merge.ts';
import { build, rebuildReport, loadBuild } from '../../semantic/src/pipeline.ts';
import { ReviewLog } from '../../semantic/src/review.ts';
import { publish, exportAnalytical } from '../../semantic/src/publish.ts';
import { ask as semanticAsk, translate as semanticTranslate } from '../../semantic/src/ask/index.ts';
import { SqlWorkspace } from '../../sqllayer/src/steps.ts';
import { SkillStore } from '../../skills/src/types.ts';
import { advise } from '../../skills/src/advise.ts';
import { toSkillMarkdown } from '../../skills/src/export.ts';
import { attribute } from '../../agents/attribution/src/index.ts';
import { campaign } from '../../agents/campaign/src/index.ts';
import { analyseRuleSet, capacityPlan, graphFeaturesReport, riskAgent, RiskApprovals } from '../../agents/risk/src/index.ts';
import { diffModels, driftReport, shadowAsk, releaseGate, type LiveTable } from '../../semantic/src/version.ts';
import { ReleaseStore, pickRevision } from '../../semantic/src/release.ts';
import { buildTimeline, TimelineLog } from '../../semantic/src/timeline.ts';
import { ask, askHybrid, AskSession, DraftQueue, interpret, learnWord, loadLexicon, lexiconPath, proposeFromQuestion, type Turn } from '../../semantic/src/ask/index.ts';
import { addAlias, buildValueVocabulary, loadAliases, loadSuppressions, loadVocabulary, saveVocabulary, suppressValue, valuesPath } from '../../semantic/src/ask/index.ts';
import { buildWriteback, validateWriteback, submitWriteback, dryRunAdapter, type PlatformAdapter, type WritebackPlan } from '../../agents/campaign/src/writeback.ts';
import { IdempotencyStore } from '../../agents/campaign/src/idempotency.ts';
import { createGateway } from '../../core/src/llm.ts';
import { authenticate, loadAuth, requireRole, Forbidden, Unauthorized, type AuthConfig, type Principal, type Role } from './auth.ts';
import { ConfirmTokens, ConfirmationRejected } from './confirm.ts';

export interface ServerOptions {
  port?: number;
  workspace?: string;
  fixtures?: string;
  graph?: string;
  auth?: AuthConfig;
  confirmSecret?: string;
  now?: () => string;
  /** Console assets live here; defaults to this source directory. */
  assetDir?: string;
}

export interface AgentServer {
  server: Server;
  listen(): Promise<string>;
  close(): Promise<void>;
  auth: AuthConfig;
}

interface Context {
  options: Required<Pick<ServerOptions, 'workspace' | 'fixtures' | 'graph' | 'now' | 'assetDir'>>;
  auth: AuthConfig;
  tokens: ConfirmTokens;
  config: ReturnType<typeof loadConfig>;
  auditPath: string;
}

/**
 * In-memory conversations for /v1/ask/hybrid: the last turn only, so the follow-up can be rebuilt against a fresh
 * database connection (a session must not hold a closed one). Bounded, because a demo server must not grow forever.
 */
const sessions = new Map<string, { turn: Turn; touched: number }>();
const SESSION_LIMIT = 200;

interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: Record<string, unknown>;
  principal: Principal;
  /** `x-pagent-group`: a scoped canary release only applies to a member of its groups. */
  group?: string;
}

type Handler = (request: Request, context: Context) => Promise<unknown> | unknown;

interface RouteDef {
  method: 'GET' | 'POST';
  path: string;
  /** Minimum role. */
  role: Role;
  summary: string;
  /** Parameters, for the catalogue. */
  input: string[];
  handler: Handler;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.name = 'HttpError';
  }
}

const MAX_BODY = 2 * 1024 * 1024;

export function createAgentServer(options: ServerOptions = {}): AgentServer {
  const config = loadConfig();
  const context: Context = {
    options: {
      workspace: options.workspace ?? config.workspace,
      fixtures: options.fixtures ?? config.fixtures,
      graph: options.graph ?? 'demo-analytics',
      now: options.now ?? (() => new Date().toISOString()),
      assetDir: options.assetDir ?? new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    },
    auth: options.auth ?? loadAuth(),
    tokens: new ConfirmTokens(options.confirmSecret ?? process.env.PAGENT_CONFIRM_SECRET ?? randomSecret()),
    config,
    auditPath: join(options.workspace ?? config.workspace, 'audit', 'api.jsonl'),
  };

  const routes = buildRoutes();
  const server = createServer((request, response) => {
    void handle(request, response, context, routes);
  });
  return {
    server,
    auth: context.auth,
    listen: () => new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : String(address));
      });
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, context: Context, routes: RouteDef[]): Promise<void> {
  const started = Date.now();
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = (request.method ?? 'GET').toUpperCase();
  let status = 200;
  let actor = 'anonymous';

  try {
    // static console assets, no auth: it is a page shell, every call it makes is authenticated
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/console.js' || url.pathname === '/console.css')) {
      const file = url.pathname === '/' ? 'console.html' : url.pathname.slice(1);
      const asset = readAsset(context.options.assetDir, file);
      status = asset ? 200 : 404;
      response.writeHead(status, { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
      response.end(asset ?? 'not found');
      return;
    }

    if (method === 'GET' && url.pathname === '/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'PhoenixAgent', at: context.options.now() }));
      return;
    }

    const principal = authenticate(context.auth, headerValue(request.headers['x-api-key']));
    actor = principal.actor;

    const match = matchRoute(routes, method, url.pathname);
    if (!match) {
      const allowed = routes.filter((entry) => entry.path === url.pathname).map((entry) => entry.method);
      throw allowed.length > 0
        ? new HttpError(405, 'method-not-allowed', `${method} ${url.pathname} is not a route`, `try ${allowed.join(' or ')}`)
        : new HttpError(404, 'not-found', `no route for ${method} ${url.pathname}`, 'GET /v1/tools lists what exists');
    }
    requireRole(principal, match.route.role);
    const body = method === 'POST' ? await readBody(request) : {};
    const group = headerValue(request.headers['x-pagent-group']);
    const result = await match.route.handler({
      method,
      path: url.pathname,
      query: url.searchParams,
      params: match.params,
      body,
      principal,
      ...(group ? { group } : {}),
    }, context);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(result));
  } catch (error) {
    const failure = toHttpError(error);
    status = failure.status;
    response.writeHead(failure.status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.hint ? { hint: failure.hint } : {}),
      },
    }));
  } finally {
    appendJsonl(context.auditPath, {
      ts: context.options.now(), actor, method, path: url.pathname, status, ms: Date.now() - started,
    });
  }
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof Unauthorized) return new HttpError(error.status, 'unauthorized', error.message);
  if (error instanceof Forbidden) return new HttpError(error.status, 'forbidden', error.message);
  if (error instanceof ConfirmationRejected) return new HttpError(error.status, error.code, error.message);
  if (error instanceof PhoenixGraphError) return new HttpError(502, 'base-unavailable', error.message, 'the base answers on PHOENIXGRAPH_API');
  return new HttpError(500, 'internal', (error as Error).message);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body-too-large', `request body over ${MAX_BODY} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'body-not-object', 'the body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'body-not-json', (error as Error).message);
  }
}

function readAsset(dir: string, file: string): string | null {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function matchRoute(routes: RouteDef[], method: string, path: string): { route: RouteDef; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.path === path) return { route, params: {} };
    if (!route.path.includes(':')) continue;
    const routeParts = route.path.split('/');
    const pathParts = path.split('/');
    if (routeParts.length !== pathParts.length) continue;
    const params: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < routeParts.length; index++) {
      const expected = routeParts[index]!;
      const actual = pathParts[index]!;
      if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
      else if (expected !== actual) {
        matches = false;
        break;
      }
    }
    if (matches) return { route, params };
  }
  return null;
}

function randomSecret(): string {
  return `local-${Math.random().toString(36).slice(2)}${Date.now()}`;
}

// ---------------------------------------------------------------------------------------------------
// the workspace accessors: one DB handle per request, model cached per build file mtime

function withDatabase<T>(context: Context, fn: (run: QueryRunner, catalog: ReturnType<typeof readSqliteCatalog>) => T): T {
  const dbPath = join(context.options.fixtures, 'data', 'demo.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const catalog = readSqliteCatalog(db, dbPath);
    const runner = sqliteRunner(db, { rowLimit: 200_000, timeoutMs: 30_000 });
    return fn((sql: string) => {
      assertReadOnly(sql);
      return runner(sql);
    }, catalog);
  } finally {
    db.close();
  }
}

function loadModel(context: Context, graph = context.options.graph): {
  index: ModelIndex;
  report: Record<string, unknown> | null;
  candidates: { id: string; status: string; entityType?: string; kind?: string; payload: unknown; note?: string }[];
  /** The same list untrimmed: the version and shadow tools need the payloads, not a summary. */
  merged: MergedCandidate[];
} {
  const stored = loadBuild({ fixtures: context.options.fixtures, graph, workspace: context.options.workspace, now: context.options.now() });
  if (!stored) {
    throw new HttpError(409, 'no-model', `no build for '${graph}'`, `POST /v1/semantic/build {"graph":"${graph}"} first`);
  }
  const report = readJson<Record<string, unknown>>(join(context.options.workspace, 'build', graph, 'report.json'));
  return { index: indexModel(stored.candidates), report, candidates: stored.candidates, merged: stored.candidates };
}

function requireString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'missing-parameter', `'${name}' is required`, `send JSON {"${name}": "..."}`);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new HttpError(400, 'bad-parameter', `'${name}' must be a number`);
  return parsed;
}

// ---------------------------------------------------------------------------------------------------
// the routes

function buildRoutes(): RouteDef[] {
  return [
    {
      method: 'GET', path: '/v1/tools', role: 'viewer',
      summary: 'the tool catalogue (generated from these routes)', input: [],
      handler: (_request, _context) => ({ tools: buildRoutes().map(describeRoute) }),
    },
    {
      method: 'POST', path: '/v1/route', role: 'viewer',
      summary: 'which sub-agent a question belongs to, and why', input: ['question'],
      handler: (request) => {
        const question = requireString(request.body, 'question');
        return route(question);
      },
    },
    {
      method: 'POST', path: '/v1/ask', role: 'viewer',
      summary: 'ask anything: routes to the semantic, attribution, campaign or risk agent',
      input: ['question', 'mode', 'confirmToken', 'from', 'to', 'metric'],
      handler: askHandler,
    },
    {
      method: 'POST', path: '/v1/attribute', role: 'viewer',
      summary: 'attribute a metric change to drivers and slices, with residual reported', input: ['metric', 'from', 'to', 'depth'],
      handler: (request, context) => {
        const metric = requireString(request.body, 'metric');
        const from = requireString(request.body, 'from');
        const to = requireString(request.body, 'to');
        return confirmable(request, 'attribute', { metric, from, to, depth: optionalNumber(request.body, 'depth') ?? 2 }, executeAttribute, context);
      },
    },
    {
      method: 'POST', path: '/v1/campaign/optimize', role: 'viewer',
      summary: 'marginal response curves, a bounded budget reallocation and a holdout design', input: ['budget', 'maxChangePct'],
      handler: (request, context) => {
        const plan = { budget: optionalNumber(request.body, 'budget'), maxChangePct: optionalNumber(request.body, 'maxChangePct') };
        return confirmable(request, 'campaign', plan, executeCampaign, context);
      },
    },
    {
      method: 'GET', path: '/v1/risk/report', role: 'viewer',
      summary: 'trend, feature effectiveness, synthesized rules and their holdout metrics', input: [],
      handler: (_request, context) => executeRisk(context, {}),
    },
    {
      method: 'POST', path: '/v1/risk/approve', role: 'owner',
      summary: 'approve or reject a rule candidate (this is the only way a rule publishes)', input: ['ruleId', 'decision', 'expression', 'note'],
      handler: (request, context) => {
        const ruleId = requireString(request.body, 'ruleId');
        const decision = requireString(request.body, 'decision');
        if (decision !== 'approve' && decision !== 'reject') {
          throw new HttpError(400, 'bad-parameter', "decision must be 'approve' or 'reject'");
        }
        return new RiskApprovals(context.options.workspace, context.options.graph)
          .decide(ruleId, String(request.body.expression ?? ''), decision, request.principal.actor,
            String(request.body.note ?? ''), context.options.now());
      },
    },
    {
      method: 'GET', path: '/v1/risk/approvals', role: 'viewer',
      summary: 'the approval log', input: [],
      handler: (_request, context) => ({ approvals: new RiskApprovals(context.options.workspace, context.options.graph).all() }),
    },
    {
      method: 'GET', path: '/v1/semantic/report', role: 'viewer',
      summary: 'the gate, coverage, completeness and drift of the current build', input: ['graph'],
      handler: (request, context) => {
        const graph = request.query.get('graph') ?? context.options.graph;
        const { report } = loadModel(context, graph);
        if (!report) throw new HttpError(404, 'no-report', `no report for '${graph}'`);
        return report;
      },
    },
    {
      method: 'GET', path: '/v1/semantic/model', role: 'viewer',
      summary: 'the semantic model: metrics, dimensions, relations, and the candidates that are not accepted', input: ['graph'],
      handler: (request, context) => {
        const graph = request.query.get('graph') ?? context.options.graph;
        const { index, candidates } = loadModel(context, graph);
        const byType = (type: string) => index.candidates.filter((candidate) => candidate.entityType === type)
          .map((candidate) => ({ id: candidate.id, payload: candidate.payload, status: candidate.status, note: candidate.note }));
        return {
          graph,
          metrics: byType('metric'),
          dimensions: byType('dimension'),
          tables: byType('table'),
          relations: index.candidates.filter((candidate) => candidate.kind === 'relation')
            .map((candidate) => ({ id: candidate.id, type: candidate.relationType, from: candidate.from, to: candidate.to })),
          needsReview: candidates.filter((candidate) => candidate.status === 'needs_review').map((candidate) => candidate.id),
        };
      },
    },
    {
      method: 'POST', path: '/v1/semantic/translate', role: 'viewer',
      summary: 'a question or a spec becomes SQL, with the SQL layer findings - nothing runs', input: ['question', 'spec', 'graph'],
      handler: (request, context) => {
        const { index, report } = loadModel(context, String(request.body.graph ?? context.options.graph));
        return semanticTranslate({
          ...(typeof request.body.question === 'string' ? { question: request.body.question } : {}),
          ...(request.body.spec ? { spec: request.body.spec as never } : {}),
          index,
          modelRevision: typeof report?.modelVersion === 'number' ? report.modelVersion : null,
        });
      },
    },
    {
      method: 'POST', path: '/v1/semantic/ask', role: 'viewer',
      summary: 'a question over the semantic model: interpret, render, execute, explain', input: ['question', 'spec', 'graph', 'compare'],
      handler: (request, context) => {
        const graph = String(request.body.graph ?? context.options.graph);
        const spec = request.body.spec as Record<string, unknown> | undefined;
        const merged = spec
          ? { ...spec, ...(request.body.compare ? { compare: request.body.compare } : {}) }
          : undefined;
        return withCanary(request, context, graph, typeof request.body.question === 'string' ? request.body.question : '',
          (chosen) => withDatabase(context, (run) => semanticAsk({
            ...(typeof request.body.question === 'string' ? { question: request.body.question } : {}),
            ...(merged ? { spec: merged as never } : {}),
            index: chosen.index,
            run,
            modelRevision: chosen.revision,
            ...(valueContext(context, graph) ? { values: valueContext(context, graph) } : {}),
          })));
      },
    },
    {
      method: 'GET', path: '/v1/semantic/release', role: 'viewer',
      summary: 'the release in flight: revisions, canary share, evidence, and the event log', input: ['graph'],
      handler: (request, context) => {
        const graph = String(request.query.get('graph') ?? context.options.graph);
        const store = new ReleaseStore(context.options.workspace, graph);
        return { config: store.get(), evidence: store.canaryEvidence(), events: store.events().slice(-50) };
      },
    },
    {
      method: 'POST', path: '/v1/semantic/release', role: 'owner',
      summary: 'start, promote or roll back a canary release between two published revisions',
      input: ['action', 'from', 'to', 'canaryPct', 'reason', 'question'],
      handler: (request, context) => {
        const graph = String(request.body.graph ?? context.options.graph);
        const store = new ReleaseStore(context.options.workspace, graph);
        const action = requireString(request.body, 'action');
        const now = context.options.now();

        if (action === 'start') {
          const from = Number(request.body.from);
          const to = Number(request.body.to);
          for (const revision of [from, to]) {
            if (!existsSync(join(context.options.workspace, 'models', graph, `v${revision}.json`))) {
              throw new HttpError(404, 'no-revision', `there is no published revision v${revision} for '${graph}'`,
                'POST /v1/semantic/publish to create one, or point from/to at snapshots that exist');
            }
          }
          try {
            const scope = request.body.scope as { groups?: unknown; dimension?: unknown; values?: unknown } | undefined;
            const guard = request.body.qualityGuard as { maxRelativeDelta?: unknown } | undefined;
            return store.start({
              from, to, canaryPct: Number(request.body.canaryPct ?? 10),
              ...(request.body.retry && typeof (request.body.retry as { reason?: unknown }).reason === 'string'
                ? { retry: { reason: String((request.body.retry as { reason: string }).reason) } }
                : {}),
              actor: request.principal.actor, now,
              ...(typeof request.body.question === 'string' ? { probeQuestion: request.body.question } : {}),
              ...(scope && (Array.isArray(scope.groups) || typeof scope.dimension === 'string')
                ? {
                  scope: {
                    ...(Array.isArray(scope.groups) ? { groups: scope.groups.map(String) } : {}),
                    ...(typeof scope.dimension === 'string'
                      ? { dimension: scope.dimension, values: Array.isArray(scope.values) ? scope.values.map(String) : [] }
                      : {}),
                  },
                }
                : {}),
              ...(guard && Number.isFinite(Number(guard.maxRelativeDelta))
                ? { qualityGuard: { maxRelativeDelta: Number(guard.maxRelativeDelta) } }
                : {}),
            });
          } catch (error) {
            throw new HttpError(409, 'release-conflict', (error as Error).message);
          }
        }

        if (action === 'promote') {
          const config = store.get();
          if (!config) throw new HttpError(409, 'no-release', `no release for '${graph}'`);
          // the probe question is compared across the two revisions before the promotion is allowed
          let shadow: 'promote' | 'hold' | undefined;
          const question = typeof request.body.question === 'string' ? request.body.question : config.probeQuestion;
          if (question) {
            const before = readJson<{ candidates: MergedCandidate[] }>(join(context.options.workspace, 'models', graph, `v${config.fromRevision}.json`));
            const after = readJson<{ candidates: MergedCandidate[] }>(join(context.options.workspace, 'models', graph, `v${config.toRevision}.json`));
            if (before?.candidates && after?.candidates) {
              shadow = withDatabase(context, (run) => shadowAsk({
                question, previous: before.candidates, next: after.candidates, run,
                revisions: { from: config.fromRevision, to: config.toRevision },
              })).verdict;
            }
          }
          if (!shadow) {
            const before = readJson<{ candidates: MergedCandidate[] }>(join(context.options.workspace, 'models', graph, `v${config.fromRevision}.json`));
            const after = readJson<{ candidates: MergedCandidate[] }>(join(context.options.workspace, 'models', graph, `v${config.toRevision}.json`));
            if (before?.candidates && after?.candidates) {
              const diff = diffModels(before.candidates, after.candidates, { from: config.fromRevision, to: config.toRevision });
              if (diff.verdict === 'breaking') {
                throw new HttpError(409, 'promotion-refused',
                  `v${config.toRevision} changes ${diff.summary.breaking} definition(s); a breaking release needs a shadow question`,
                  'POST /v1/semantic/release {action:"promote", question:"..."} so the numbers are compared before promotion');
              }
            }
          }
          try {
            const watchHours = optionalNumber(request.body, 'watchHours');
            return store.promote({
              actor: request.principal.actor, now,
              ...(shadow ? { shadow } : {}),
              ...(watchHours === undefined ? {} : { watchHours }),
            });
          } catch (error) {
            throw new HttpError(409, 'promotion-refused', (error as Error).message,
              'GET /v1/semantic/release shows the canary evidence; more traffic or a fix is what unblocks it');
          }
        }

        if (action === 'rollback') {
          try {
            return store.rollback({ actor: request.principal.actor, reason: String(request.body.reason ?? ''), now });
          } catch (error) {
            throw new HttpError(400, 'rollback-needs-a-reason', (error as Error).message);
          }
        }

        throw new HttpError(400, 'bad-parameter', `unknown action '${action}'`, 'use start, promote or rollback');
      },
    },
    {
      method: 'POST', path: '/v1/semantic/validate', role: 'viewer',
      summary: 'compile the SQL for a question without executing it', input: ['question', 'spec', 'graph'],
      handler: (request, context) => {
        const { index, report } = loadModel(context, String(request.body.graph ?? context.options.graph));
        const translated = semanticTranslate({
          ...(typeof request.body.question === 'string' ? { question: request.body.question } : {}),
          ...(request.body.spec ? { spec: request.body.spec as never } : {}),
          index,
          modelRevision: typeof report?.modelVersion === 'number' ? report.modelVersion : null,
        });
        if (!translated.plan) return { ok: false, refusals: translated.refusals };
        const plan = translated.plan;
        return withDatabase(context, (run) => {
          try {
            run(`${plan.sql[0]} LIMIT 0`);
            return { ok: true, sql: plan.sql[0], findings: plan.findings };
          } catch (error) {
            return { ok: false, sql: plan.sql[0], error: (error as Error).message };
          }
        });
      },
    },
    {
      method: 'POST', path: '/v1/semantic/build', role: 'analyst',
      summary: 'rebuild the semantic model from the fixture sources', input: ['graph', 'includeInjected'],
      handler: (request, context) => {
        const graph = String(request.body.graph ?? context.options.graph);
        const start = Date.now();
        const outcome = build({
          fixtures: context.options.fixtures, graph, workspace: context.options.workspace,
          now: context.options.now(), includeInjected: request.body.includeInjected === true,
        });
        return {
          graph, modelVersion: outcome.modelVersion, gate: outcome.report.gate,
          coverage: outcome.report.coverage, conflicts: outcome.report.conflicts,
          needsReview: outcome.reviewed.filter((candidate) => candidate.status === 'needs_review').map((candidate) => candidate.id),
          ms: Date.now() - start,
        };
      },
    },
    {
      method: 'POST', path: '/v1/semantic/review', role: 'analyst',
      summary: 'accept, reject, edit, resolve or add a candidate (append-only)', input: ['action', 'target', 'reason', 'patch'],
      handler: (request, context) => {
        const action = requireString(request.body, 'action');
        if (!['accept', 'reject', 'edit', 'resolve-conflict', 'add'].includes(action)) {
          throw new HttpError(400, 'bad-parameter', `unknown action '${action}'`,
            'use accept, reject, edit, resolve-conflict or add');
        }
        const graph = String(request.body.graph ?? context.options.graph);
        const log = new ReviewLog(join(context.options.workspace, 'reviews', `${graph}.jsonl`));
        const revision = log.append({
          ts: context.options.now(), actor: request.principal.actor, action: action as never,
          target: String(request.body.target ?? ''), reason: String(request.body.reason ?? ''),
          ...(request.body.patch === undefined ? {} : { patch: request.body.patch as Record<string, unknown> }),
        });
        new TimelineLog(context.options.workspace, graph).append({
          at: context.options.now(), kind: 'review', actor: request.principal.actor,
          detail: `${action} ${String(request.body.target ?? '')}${request.body.reason ? ` - ${String(request.body.reason)}` : ''}`,
        });
        const outcome = rebuildReport({
          fixtures: context.options.fixtures, graph, workspace: context.options.workspace, now: context.options.now(),
        });
        return { revision, gate: outcome.report.gate, coverage: outcome.report.coverage };
      },
    },
    {
      method: 'POST', path: '/v1/semantic/publish', role: 'owner',
      summary: 'write the reviewed model into PhoenixGraph and snapshot the revision', input: ['graph'],
      handler: async (request, context) => {
        const graph = String(request.body.graph ?? context.options.graph);
        const outcome = rebuildReport({
          fixtures: context.options.fixtures, graph, workspace: context.options.workspace, now: context.options.now(),
        });
        if (!outcome.report.gate.passed) {
          throw new HttpError(409, 'gate-refused', 'the gate refused to publish', outcome.report.gate.reasons.join('; '));
        }
        const previous = readJson<{ candidates: never[] }>(join(context.options.workspace, 'models', graph,
          `v${Math.max(1, outcome.modelVersion - 1)}.json`));
        const client = new GraphClient(context.config.phoenix);
        const revision = outcome.modelVersion;
        const result = await publish(client, {
          graph, candidates: outcome.reviewed, revision,
          ...(previous?.candidates ? { previousCandidates: previous.candidates as never } : {}),
        });
        const snapshot = join(context.options.workspace, 'models', graph, `v${revision}.json`);
        new TimelineLog(context.options.workspace, graph).append({
          at: context.options.now(), kind: 'publish', actor: request.principal.actor,
          detail: `${graph} published v${revision}`, revision,
        });
        return { ...result, snapshot, analyticalExport: exportAnalytical(graph, outcome.reviewed, revision) as unknown as null };
      },
    },
    {
      method: 'POST', path: '/v1/sql/plan', role: 'analyst',
      summary: 'analyze a statement, propose rewrites, and price both sides', input: ['sql', 'requiredColumns', 'dialect'],
      handler: (request, context) => {
        const sql = requireString(request.body, 'sql');
        const required = Array.isArray(request.body.requiredColumns)
          ? (request.body.requiredColumns as unknown[]).map(String) : [];
        return withDatabase(context, (_run, catalog) => {
          const workspace = new SqlWorkspace(join(context.options.workspace, 'sql'));
          return workspace.plan(sql, {
            catalog, dbPath: join(context.options.fixtures, 'data', 'demo.db'),
            requiredColumns: required, actor: request.principal.actor, now: context.options.now(),
          });
        });
      },
    },
    {
      method: 'GET', path: '/v1/sql/steps/:id', role: 'viewer',
      summary: 'replay a plan ledger', input: [],
      handler: (request, context) => new SqlWorkspace(join(context.options.workspace, 'sql')).state(request.params.id!),
    },
    {
      method: 'POST', path: '/v1/sql/steps/:id', role: 'analyst',
      summary: 'apply, revert or hand-edit a step (a human edit is a ledger entry)', input: ['action', 'step', 'sql', 'note'],
      handler: (request, context) => {
        const workspace = new SqlWorkspace(join(context.options.workspace, 'sql'));
        const id = request.params.id!;
        const action = requireString(request.body, 'action');
        const actor = request.principal.actor;
        if (action === 'apply') {
          const step = Number(request.body.step ?? 0);
          const state = workspace.state(id);
          const target = state.steps.find((entry) => entry.seq === step);
          if (!target) throw new HttpError(400, 'unknown-step', `plan '${id}' has no step ${step}`);
          if (target.kind !== 'rewrite') {
            throw new HttpError(400, 'suggestion-not-appliable',
              `step ${step} is a suggestion: applying it would change the answer`,
              'suggestions are for a person to accept by editing the SQL, not for the service to apply');
          }
          return workspace.apply(id, step, actor);
        }
        if (action === 'revert') return workspace.revert(id, Number(request.body.step ?? 0), actor);
        if (action === 'edit') {
          return workspace.edit(id, requireString(request.body, 'sql'), actor, String(request.body.note ?? 'edited over HTTP'));
        }
        throw new HttpError(400, 'bad-parameter', `unknown action '${action}'`, 'use apply, revert or edit');
      },
    },
    {
      method: 'GET', path: '/v1/skills', role: 'viewer',
      summary: 'the skill library, with scores and status', input: ['status', 'agent'],
      handler: (request, context) => {
        const store = new SkillStore(join(context.options.workspace, 'skills'));
        const status = request.query.get('status') ?? undefined;
        const agent = request.query.get('agent') ?? undefined;
        return {
          tips: store.list({
            ...(status ? { status: status as never } : {}),
            ...(agent ? { agent: agent as never } : {}),
          }).map((tip) => ({
            id: tip.id, statement: tip.statement, status: tip.status, scope: tip.scope,
            score: SkillStore.score(tip), confirmations: tip.confirmations.length, misses: tip.misses,
            evidence: tip.evidence.length,
          })),
        };
      },
    },
    {
      method: 'POST', path: '/v1/skills/advise', role: 'viewer',
      summary: 'which tips apply to a statement, and why', input: ['sql', 'dialect', 'exclude'],
      handler: (request, context) => {
        const sql = requireString(request.body, 'sql');
        const store = new SkillStore(join(context.options.workspace, 'skills'));
        return withDatabase(context, (_run, catalog) => advise(store, sql, {
          catalog,
          ...(typeof request.body.dialect === 'string' ? { dialect: request.body.dialect } : {}),
          ...(Array.isArray(request.body.exclude) ? { exclude: (request.body.exclude as unknown[]).map(String) } : {}),
        }));
      },
    },
    {
      method: 'POST', path: '/v1/skills/decide', role: 'analyst',
      summary: 'confirm, dispute, promote or retire a tip', input: ['id', 'action', 'note', 'run'],
      handler: (request, context) => {
        const store = new SkillStore(join(context.options.workspace, 'skills'));
        const id = requireString(request.body, 'id');
        const action = requireString(request.body, 'action');
        const actor = request.principal.actor;
        const note = String(request.body.note ?? '');
        const run = String(request.body.run ?? `${actor}-${context.options.now()}`);
        if (action === 'confirm') return store.confirm(id, run, actor, note);
        if (action === 'miss') return store.miss(id, run, actor, note);
        if (action === 'promote') return store.promote(id, actor, note || 'promoted over HTTP');
        if (action === 'demote') return store.demote(id, actor, note || 'withdrawn over HTTP');
        throw new HttpError(400, 'bad-parameter', `unknown action '${action}'`, 'use confirm, miss, promote or demote');
      },
    },
    {
      method: 'GET', path: '/v1/skills/export', role: 'viewer',
      summary: 'SKILL.md for the library', input: ['status'],
      handler: (request, context) => {
        const store = new SkillStore(join(context.options.workspace, 'skills'));
        const status = request.query.get('status') ?? undefined;
        const tips = store.list(status ? { status: status as never } : {});
        return { markdown: toSkillMarkdown(tips, {
          name: 'phoenixagent-skills', description: 'harvested from real runs',
          generatedAt: context.options.now(),
        }) };
      },
    },
    {
      method: 'POST', path: '/v1/semantic/version', role: 'viewer',
      summary: 'diff two model revisions, check drift against the warehouse, shadow a question, and gate the release',
      input: ['graph', 'question', 'from'],
      handler: (request, context) => {
        const graph = String(request.body.graph ?? context.options.graph);
        const { merged: candidates } = loadModel(context, graph);
        const built = Number(readJson<{ modelVersion?: number }>(join(context.options.workspace, 'build', graph, 'report.json'))?.modelVersion ?? 1);
        const fromRevision = Number(request.body.from ?? built - 1);
        const snapshot = readJson<{ candidates: typeof candidates }>(join(context.options.workspace, 'models', graph, `v${fromRevision}.json`));
        const previous = snapshot?.candidates ?? candidates;
        const diff = diffModels(previous, candidates, { from: fromRevision, to: built });
        const drift = driftReport(candidates, liveTables(context));
        const question = typeof request.body.question === 'string' && request.body.question.trim().length > 0
          ? request.body.question : null;
        const shadows = question
          ? [withDatabase(context, (run) => shadowAsk({ question, previous, next: candidates, run, revisions: { from: fromRevision, to: built } }))]
          : [];
        return { graph, diff, drift, shadows, gate: releaseGate({ diff, drift, shadows }) };
      },
    },
    {
      method: 'POST', path: '/v1/semantic/shadow', role: 'viewer',
      summary: 'the same question under two revisions, with the row-level movement and a promote/hold verdict',
      input: ['question', 'graph', 'from', 'tolerance'],
      handler: (request, context) => {
        const question = requireString(request.body, 'question');
        const graph = String(request.body.graph ?? context.options.graph);
        const { merged: candidates } = loadModel(context, graph);
        const fromRevision = Number(request.body.from ?? 0);
        const snapshot = readJson<{ candidates: typeof candidates }>(join(context.options.workspace, 'models', graph, `v${fromRevision}.json`));
        return withDatabase(context, (run) => shadowAsk({
          question,
          previous: snapshot?.candidates ?? candidates,
          next: candidates,
          run,
          revisions: { from: fromRevision, to: 0 },
          ...(request.body.tolerance === undefined ? {} : { tolerance: Number(request.body.tolerance) }),
        }));
      },
    },
    {
      method: 'GET', path: '/v1/semantic/lexicon', role: 'viewer',
      summary: 'the words learned so far (a word is a rewrite, applied before anything parses the question)',
      input: ['graph'],
      handler: (request, context) => ({
        graph: String(request.query.get('graph') ?? context.options.graph),
        entries: loadLexicon(context.options.workspace, String(request.query.get('graph') ?? context.options.graph)),
      }),
    },
    {
      method: 'POST', path: '/v1/semantic/lexicon', role: 'analyst',
      summary: 'learn a word onto a metric or dimension (the target must exist, the word must be new)',
      input: ['word', 'target', 'graph', 'evidence'],
      handler: (request, context) => {
        const graph = String(request.body.graph ?? context.options.graph);
        const { index } = loadModel(context, graph);
        let entry;
        try {
          entry = learnWord({
            workspace: context.options.workspace, graph, index,
            word: requireString(request.body, 'word'), target: requireString(request.body, 'target'),
            source: 'review', model: request.principal.actor,
            evidence: String(request.body.evidence ?? ''), now: context.options.now(),
          });
        } catch (error) {
          // a word that already means something, or a target the model does not have: a conflict, not a server fault
          throw new HttpError(409, 'lexicon-conflict', (error as Error).message,
            'GET /v1/semantic/lexicon lists what is already learned');
        }
        return { entry, path: lexiconPath(context.options.workspace, graph) };
      },
    },
    {
      method: 'GET', path: '/v1/semantic/lexicon/drafts', role: 'viewer',
      summary: 'words proposed for the vocabulary and not yet certified', input: ['status', 'graph'],
      handler: (request, context) => {
        const graph = String(request.query.get('graph') ?? context.options.graph);
        const queue = new DraftQueue(context.options.workspace, graph);
        const status = request.query.get('status');
        return { drafts: status === 'pending' ? queue.pending() : queue.all() };
      },
    },
    {
      method: 'POST', path: '/v1/semantic/lexicon/drafts', role: 'analyst',
      summary: 'propose a word (explicitly, or by asking a model which words are unknown)', input: ['word', 'target', 'question', 'graph'],
      handler: async (request, context) => {
        const graph = String(request.body.graph ?? context.options.graph);
        const { index } = loadModel(context, graph);
        const queue = new DraftQueue(context.options.workspace, graph);
        if (typeof request.body.word === 'string' && request.body.word.trim().length > 0) {
          // the explicit path works with the model switched off: a person proposes, another certifies
          try {
            return queue.propose({
              word: String(request.body.word), target: String(request.body.target ?? ''), question: String(request.body.question ?? ''),
              index, source: 'manual', model: request.principal.actor, proposedBy: request.principal.actor, now: context.options.now(),
            });
          } catch (error) {
            throw new HttpError(409, 'draft-rejected', (error as Error).message);
          }
        }
        const question = requireString(request.body, 'question');
        try {
          return await proposeFromQuestion({
            question, index, gateway: createGateway(context.config.llm),
            actor: request.principal.actor, workspace: context.options.workspace, graph, now: context.options.now(),
          });
        } catch (error) {
          throw new HttpError(409, 'llm-unavailable', (error as Error).message,
            'send {word, target, question} to propose one by hand instead');
        }
      },
    },
    {
      method: 'POST', path: '/v1/semantic/lexicon/drafts/:id', role: 'analyst',
      summary: 'certify or reject a proposed word (the proposer cannot certify their own)', input: ['action', 'reason'],
      handler: (request, context) => {
        const graph = String(request.body.graph ?? context.options.graph);
        const { index } = loadModel(context, graph);
        const action = requireString(request.body, 'action');
        if (action !== 'accept' && action !== 'reject') {
          throw new HttpError(400, 'bad-parameter', "action must be 'accept' or 'reject'");
        }
        try {
          return new DraftQueue(context.options.workspace, graph).decide(request.params.id!, {
            action, actor: request.principal.actor, index,
            ...(typeof request.body.reason === 'string' ? { reason: request.body.reason } : {}),
            now: context.options.now(),
          });
        } catch (error) {
          throw new HttpError(409, 'draft-decision-refused', (error as Error).message);
        }
      },
    },
    {
      method: 'POST', path: '/v1/ask/hybrid', role: 'viewer',
      summary: 'ask with an optional model proposal, validated deterministically; followUp continues a session',
      input: ['question', 'sessionId', 'followUp', 'graph'],
      handler: async (request, context) => {
        const question = requireString(request.body, 'question');
        const graph = String(request.body.graph ?? context.options.graph);
        const { index } = loadModel(context, graph);
        const gateway = createGateway(context.config.llm);
        if (request.body.followUp === true) {
          const id = requireString(request.body, 'sessionId');
          const entry = sessions.get(id);
          if (!entry) {
            throw new HttpError(404, 'no-session', `no session '${id}'`,
              'ask once without followUp, then resend with the sessionId it returned');
          }
          entry.touched = Date.now();
          return withDatabase(context, (run) => {
            const session = new AskSession({ index, run, workspace: context.options.workspace, graph, gateway, now: new Date(context.options.now()) });
            session.restore(entry.turn);
            return session.followUp(question);
          });
        }
        const sessionsBefore = sessions.size;
        const routing = canaryRoute(context, graph, request.principal.actor, question, request.group);
        const result = await withDatabaseAsync(context, async (run) => {
          const session = new AskSession({
            index: routing.index, run, workspace: context.options.workspace, graph, gateway, now: new Date(context.options.now()),
            ...(valueContext(context, graph) ? { values: valueContext(context, graph) } : {}),
          });
          const answer = await session.ask(question);
          return { answer, turn: session.turns[session.turns.length - 1]! };
        }).catch((error) => {
          // a canary failure is recorded and re-raised, never answered from the stable side
          throw canaryFailure(context, routing, error);
        });
        if (routing.side === 'canary') {
          routing.store!.record({
            ts: context.options.now(), kind: 'answer', revision: routing.revision ?? 0, side: 'canary',
            actor: request.principal.actor, question,
          });
        }
        const sessionId = `s${Date.now().toString(36)}${(sessionsBefore % 1296).toString(36)}`;
        sessions.set(sessionId, { turn: result.turn, touched: Date.now() });
        // evict the least recently used conversation: the limit is a guard, not a feature
        if (sessions.size > SESSION_LIMIT) {
          const oldest = [...sessions.entries()].sort((left, right) => left[1].touched - right[1].touched)[0];
          if (oldest) sessions.delete(oldest[0]);
        }
        return { ...result.answer, sessionId };
      },
    },
    {
      method: 'POST', path: '/v1/graph/features', role: 'viewer',
      summary: 'structural graph features, their AUC, and the held-out increment over the row features',
      input: ['cutoff', 'grain', 'crossCheck'],
      handler: async (request, context) => {
        const cutoff = typeof request.body.cutoff === 'string' ? request.body.cutoff : '2025-07';
        const grain = request.body.grain === 'week' ? 'week' as const : 'month' as const;
        const crossCheck = request.body.crossCheck === true;
        if (crossCheck && request.principal.role !== 'owner') {
          // publishing the snapshot writes into PhoenixGraph: that is an owner action, not a read
          throw new Forbidden('crossCheck publishes a graph into PhoenixGraph and needs the owner role');
        }
        const client = crossCheck ? new GraphClient(context.config.phoenix) : undefined;
        return withDatabaseAsync(context, (run) => graphFeaturesReport({ run, cutoff, grain, ...(client ? { client, crossCheck } : {}) }));
      },
    },
    {
      method: 'POST', path: '/v1/risk/conflicts', role: 'viewer',
      summary: 'the rule set as a system: duplicates, subsets, action conflicts, unreachable rules and marginals',
      input: ['months', 'rules'],
      handler: (request, context) => withDatabase(context, (run) => {
        const months = Number(request.body.months ?? 6);
        const events = loadRiskEvents(run, months);
        const live = run("SELECT rule_id, expression FROM risk_rule WHERE status = 'active' ORDER BY rule_id").rows;
        const supplied = Array.isArray(request.body.rules) ? (request.body.rules as Record<string, unknown>[]) : [];
        const rules = [
          ...live.map((row) => ({ ruleId: String(row.rule_id), expression: String(row.expression) })),
          ...supplied
            .map((row) => ({
              ruleId: String(row.ruleId ?? ''), expression: String(row.expression ?? ''),
              ...(typeof row.action === 'string' ? { action: row.action as 'block' | 'review' | 'challenge' } : {}),
            }))
            .filter((rule) => rule.ruleId.length > 0 && rule.expression.length > 0),
        ];
        return analyseRuleSet({ events, rules });
      }),
    },
    {
      method: 'POST', path: '/v1/risk/capacity', role: 'viewer',
      summary: 'how many reviewers a rule volume needs, by Erlang-C, refusing to estimate a saturated queue',
      input: ['hitsPerDay', 'minutesPerReview', 'reviewers', 'targetServiceLevel', 'slaHours'],
      handler: (request) => {
        const target = optionalNumber(request.body, 'targetServiceLevel');
        const sla = optionalNumber(request.body, 'slaHours');
        return capacityPlan({
          hitsPerDay: optionalNumber(request.body, 'hitsPerDay') ?? 0,
          minutesPerReview: optionalNumber(request.body, 'minutesPerReview') ?? 12,
          reviewers: optionalNumber(request.body, 'reviewers') ?? 1,
          ...(target === undefined ? {} : { targetServiceLevel: target }),
          ...(sla === undefined ? {} : { slaHours: sla }),
        });
      },
    },
    {
      method: 'GET', path: '/v1/semantic/values', role: 'viewer',
      summary: 'the value vocabulary: which words are a slice of which dimension, and where they were read from',
      input: ['graph'],
      handler: (request, context) => {
        const graph = String(request.query.get('graph') ?? context.options.graph);
        return {
          vocabulary: loadVocabulary(context.options.workspace, graph),
          aliases: loadAliases(context.options.workspace, graph),
          suppressions: loadSuppressions(context.options.workspace, graph),
          path: valuesPath(context.options.workspace, graph),
        };
      },
    },
    {
      method: 'POST', path: '/v1/semantic/values', role: 'analyst',
      summary: 'rebuild the value vocabulary from the warehouse, or record an alias for a value',
      input: ['action', 'word', 'dimension', 'value', 'note'],
      handler: (request, context) => {
        const graph = String(request.body.graph ?? context.options.graph);
        const action = String(request.body.action ?? 'build');
        if (action === 'build') {
          const { index } = loadModel(context, graph);
          const vocabulary = withDatabase(context, (run) => buildValueVocabulary({
            index, run, graph, now: context.options.now(),
            ...(Array.isArray(request.body.dimensions) ? { dimensionIds: (request.body.dimensions as unknown[]).map(String) } : {}),
          }));
          saveVocabulary(context.options.workspace, vocabulary);
          return vocabulary;
        }
        if (action === 'alias') {
          const vocabulary = loadVocabulary(context.options.workspace, graph);
          if (!vocabulary) {
            throw new HttpError(409, 'no-vocabulary', `no value vocabulary for '${graph}'`, 'POST /v1/semantic/values {"action":"build"} first');
          }
          try {
            return addAlias({
              workspace: context.options.workspace, graph, vocabulary,
              word: requireString(request.body, 'word'), dimension: requireString(request.body, 'dimension'),
              value: requireString(request.body, 'value'), actor: request.principal.actor,
              note: String(request.body.note ?? ''), now: context.options.now(),
            });
          } catch (error) {
            throw new HttpError(409, 'alias-refused', (error as Error).message);
          }
        }
        if (action === 'suppress') {
          const vocabulary = loadVocabulary(context.options.workspace, graph);
          if (!vocabulary) {
            throw new HttpError(409, 'no-vocabulary', `no value vocabulary for '${graph}'`, 'build it first');
          }
          try {
            return suppressValue({
              workspace: context.options.workspace, graph, vocabulary,
              ...(typeof request.body.word === 'string' ? { word: request.body.word } : {}),
              ...(typeof request.body.dimension === 'string' ? { dimension: request.body.dimension } : {}),
              ...(typeof request.body.value === 'string' ? { value: request.body.value } : {}),
              reason: String(request.body.reason ?? ''), actor: request.principal.actor, now: context.options.now(),
            });
          } catch (error) {
            throw new HttpError(409, 'suppression-refused', (error as Error).message);
          }
        }
        throw new HttpError(400, 'bad-parameter', `unknown action '${action}'`, 'use build, alias or suppress');
      },
    },
    {
      method: 'GET', path: '/v1/semantic/timeline', role: 'viewer',
      summary: 'one merged history: reviews, publishes, releases, learned words and drafts, in order',
      input: ['graph', 'limit'],
      handler: (request, context) => {
        const graph = String(request.query.get('graph') ?? context.options.graph);
        const timeline = buildTimeline({ workspace: context.options.workspace, graph, auditPath: context.auditPath });
        const limit = Number(request.query.get('limit') ?? 200);
        const events = timeline.events.slice(-Math.max(1, Math.min(limit, 2000)));
        return { ...timeline, events, counts: timeline.counts };
      },
    },
    {
      method: 'POST', path: '/v1/campaign/writeback', role: 'analyst',
      summary: 'turn the allocation into a platform payload: dry run by default, commit needs owner + confirm token',
      input: ['budget', 'maxChangePct', 'platform', 'effectiveFrom', 'commit', 'confirmToken'],
      handler: (request, context) => {
        const budget = optionalNumber(request.body, 'budget');
        const maxChangePct = optionalNumber(request.body, 'maxChangePct');
        const platform = String(request.body.platform ?? 'dry-run');
        const commit = request.body.commit === true;
        const effectiveFrom = String(request.body.effectiveFrom ?? context.options.now().slice(0, 10));
        const tokenPlan = { budget: budget ?? null, maxChangePct: maxChangePct ?? null, platform, effectiveFrom, commit: true };

        if (commit) {
          if (request.principal.role !== 'owner') {
            throw new Forbidden('committing a change to live spend needs the owner role');
          }
          const token = request.body.confirmToken;
          if (typeof token !== 'string' || token.length === 0) {
            if (request.body.mode === 'confirm') {
              return { mode: 'confirm', scope: 'writeback', plan: tokenPlan, ...context.tokens.issue(tokenPlan, 'writeback', Date.parse(context.options.now())), note: 'nothing ran; resend with confirmToken to commit' };
            }
            throw new HttpError(428, 'confirm-required', 'committing a write-back needs a confirmToken',
              'call once with mode:"confirm" to receive a token for this exact plan, then resend it');
          }
          context.tokens.verify(token, tokenPlan, 'writeback');
        }

        const built = withDatabase(context, (run) => campaign({
          run, index: loadModel(context).index,
          ...(budget === undefined ? {} : { budget }),
          ...(maxChangePct === undefined ? {} : { maxChangePct }),
        }));
        if (built.refusals.length > 0 || built.allocation.cells.length === 0) {
          // the agent refused to produce a plan (a cut this deep loses more revenue than it saves). There is nothing
          // honest to write back, so this is a refusal - not an empty payload with a valid-looking key.
          throw new HttpError(409, 'agent-refused',
            built.refusals[0]?.message ?? 'the campaign agent returned no cells',
            built.refusals[0]?.hint ?? 'ask for a budget the agent can justify, or read GET /v1/campaign/optimize first');
        }
        const payload = buildWriteback(built.allocation, {
          platform, effectiveFrom,
          budget: built.budget,
          maxChangePct: maxChangePct ?? 0.5,
          budgetIsCap: built.allocation.totals.proposedSpend < built.budget - 0.01,
        });
        const options = { budget: built.budget, maxChangePct: maxChangePct ?? 0.5 };
        const issues = validateWriteback(payload, built.allocation, options);
        const adapter = writebackAdapter(context, platform);
        return withDatabaseAsync(context, async () => {
          const receipt = await submitWriteback(payload, adapter, {
            commit, now: context.options.now(),
            // our own record of what was committed: the platform's deduplication is a promise, not a check
            store: new IdempotencyStore(context.options.workspace),
            actor: request.principal.actor,
          });
          return {
            platform, commit, budget: built.budget,
            payload: { ...payload, checks: payload.checks },
            issues, receipt,
            status: issues.length > 0 || receipt.status === 'rejected' ? 'blocked' : receipt.status,
          };
        });
      },
    },
    {
      method: 'GET', path: '/v1/audit/recent', role: 'owner',
      summary: 'the last N API calls, with actor and status', input: ['limit'],
      handler: (request, context) => {
        const limit = Number(request.query.get('limit') ?? 50);
        const entries = readJsonl<Record<string, unknown>>(context.auditPath);
        return { entries: entries.slice(-Math.max(1, Math.min(limit, 500))) };
      },
    },
  ];
}

function describeRoute(route: RouteDef): { name: string; method: string; path: string; role: Role; summary: string; input: string[] } {
  return {
    name: `${route.method} ${route.path}`,
    method: route.method,
    path: route.path,
    role: route.role,
    summary: route.summary,
    input: route.input,
  };
}

// ---------------------------------------------------------------------------------------------------
// handlers with the confirm gate

async function confirmable(request: Request, scope: string, plan: Record<string, unknown>,
  execute: (plan: Record<string, unknown>, context: Context, actor: string) => Promise<unknown> | unknown,
  context: Context): Promise<unknown> {
  const token = request.body.confirmToken;
  if (typeof token === 'string' && token.length > 0) {
    context.tokens.verify(token, plan, scope);
    return execute(plan, context, request.principal.actor);
  }
  if (request.body.mode === 'confirm') {
    const issued = context.tokens.issue(plan, scope, Date.parse(context.options.now()));
    return { mode: 'confirm', scope, plan, ...issued, note: 'nothing ran; send the same plan with confirmToken' };
  }
  return execute(plan, context, request.principal.actor);
}

function executeAttribute(plan: Record<string, unknown>, context: Context): unknown {
  return withDatabase(context, (run) => {
    const { index } = loadModel(context);
    return attribute({
      metric: String(plan.metric), from: String(plan.from), to: String(plan.to),
      maxDepth: Number(plan.depth ?? 2), index, run,
    });
  });
}

function executeCampaign(plan: Record<string, unknown>, context: Context): unknown {
  return withDatabase(context, (run) => {
    const { index } = loadModel(context);
    return campaign({
      run, index,
      ...(plan.budget === undefined || plan.budget === null ? {} : { budget: Number(plan.budget) }),
      ...(plan.maxChangePct === undefined || plan.maxChangePct === null ? {} : { maxChangePct: Number(plan.maxChangePct) }),
    });
  });
}

function executeRisk(context: Context, options: Record<string, unknown>): unknown {
  return withDatabase(context, (run) => riskAgent({
    run, graph: context.options.graph, workspace: context.options.workspace,
    ...(options.holdoutMonths === undefined ? {} : { holdoutMonths: Number(options.holdoutMonths) }),
  }));
}



/**
 * Which revision this request is served from, and the index that goes with it.
 *
 * A running release splits traffic by a sticky bucket; the canary side loads the snapshot of `toRevision`. Everything
 * else - no release, a rolled-back one - is the current build, which is also what `modelRevision` reports.
 */
function canaryRoute(context: Context, graph: string, actor: string, question: string, group?: string,
  filters?: { dimension: string; value: string }[]): {
  index: ModelIndex;
  stableIndex: ModelIndex;
  revision: number | null;
  side: 'stable' | 'canary' | 'promoted' | 'rolled-back' | 'none' | 'out-of-scope';
  store?: ReleaseStore;
  qualityGuard?: { maxRelativeDelta: number };
  /** True while a promoted revision is still inside its watch window. */
  watching?: boolean;
} {
  const store = new ReleaseStore(context.options.workspace, graph);
  const config = store.get();
  const picked = pickRevision(config, actor, question, group, filters);
  const stableIndex = loadModel(context, graph).index;
  if (picked.revision === 'stable' || !config) {
    return { index: stableIndex, stableIndex, revision: null, side: picked.side };
  }
  const snapshot = readJson<{ candidates: MergedCandidate[] }>(join(context.options.workspace, 'models', graph, `v${config.toRevision}.json`));
  if (!snapshot?.candidates) {
    // a release whose snapshot disappeared is a broken release: say so instead of quietly serving the stable side
    throw new HttpError(409, 'canary-revision-missing',
      `the canary points at v${config.toRevision}, but that snapshot is gone`,
      'roll the release back: POST /v1/semantic/release {action:"rollback", reason:"..."}');
  }
  return {
    index: indexModel(snapshot.candidates), stableIndex, revision: config.toRevision,
    side: picked.side, store, ...(config.qualityGuard ? { qualityGuard: config.qualityGuard } : {}),
    ...(store.watchActive(context.options.now()) ? { watching: true } : {}),
  };
}

/** Records the outcome of a canary request and rolls back automatically after repeated failures. */
function canaryFailure(context: Context, route: { side: string; revision: number | null; store?: ReleaseStore }, error: unknown): unknown {
  if (route.side !== 'canary' || !route.store) return error;
  route.store.record({
    ts: context.options.now(), kind: 'error', revision: route.revision ?? 0, side: 'canary', actor: 'unknown',
    detail: (error as Error).message.slice(0, 300),
  });
  route.store.autoRollbackAfterErrors({ actor: 'canary-guard', now: context.options.now() });
  return error;
}

function valueContext(context: Context, graph: string) {
  const vocabulary = loadVocabulary(context.options.workspace, graph);
  if (!vocabulary) return undefined;
  return {
    vocabulary,
    aliases: loadAliases(context.options.workspace, graph),
    suppressions: loadSuppressions(context.options.workspace, graph),
  };
}

/** The explicit value filters a request carries, which is what a dimension-scoped canary routes on. */
function specFilters(request: Request): { dimension: string; value: string }[] {
  const spec = request.body.spec as { filters?: unknown } | undefined;
  if (!Array.isArray(spec?.filters)) return [];
  return (spec.filters as unknown[])
    .filter((entry): entry is { dimension: string; value: string } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { dimension?: unknown }).dimension === 'string'
      && typeof (entry as { value?: unknown }).value === 'string');
}

/**
 * The filters a scoped canary routes on: the explicit ones, plus the ones the vocabulary derives from the words.
 *
 * A question that says 华东 carries no  in its spec - the filter appears when the interpreter runs, which is
 * after the revision has been chosen. So for a dimension-scoped release the question is interpreted once against the
 * stable model (cheap, no SQL) purely to learn which slice it is about. Without a vocabulary there is nothing to
 * derive, and the release stays scoped to explicit filters only - that is the honest limit, not a silent default.
 */
function filtersForRouting(context: Context, graph: string, request: Request, question: string): { dimension: string; value: string }[] {
  const explicit = specFilters(request);
  if (explicit.length > 0 || question.trim().length === 0) return explicit;
  const values = valueContext(context, graph);
  if (!values) return explicit;
  try {
    const interpreted = interpret(question, loadModel(context, graph).index, new Date(context.options.now()), values);
    return interpreted.spec?.filters ?? [];
  } catch {
    return explicit;
  }
}

/** The number a quality guard compares: the answer's total, from either the semantic or the hybrid result shape. */
function totalOf(result: unknown): number | null {
  const shaped = result as { answer?: { total?: unknown; answer?: { total?: unknown } } } | null;
  const direct = shaped?.answer?.total;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const nested = shaped?.answer?.answer?.total;
  return typeof nested === 'number' && Number.isFinite(nested) ? nested : null;
}

/** Runs `fn` against the canary index when the bucket says so, and records the outcome either way. */
function withCanary<T>(request: Request, context: Context, graph: string, question: string,
  fn: (chosen: { index: ModelIndex; revision: number | null }) => T): T {
  const route = canaryRoute(context, graph, request.principal.actor, question, request.group, filtersForRouting(context, graph, request, question));
  try {
    const result = fn({ index: route.index, revision: route.revision });
    const guarded = route.side === 'canary' || (route.side === 'promoted' && route.watching === true);
    if (guarded && route.qualityGuard) {
      // the guard answers the same question on the stable revision: a canary whose *number* moved is a failure even
      // when it did not throw, which is the whole point of a canary on a model change
      const stable = fn({ index: route.stableIndex, revision: null });
      const canaryTotal = totalOf(result);
      const stableTotal = totalOf(stable);
      if (canaryTotal !== null && stableTotal !== null && stableTotal !== 0) {
        const moved = Math.abs(canaryTotal / stableTotal - 1);
        if (moved > route.qualityGuard.maxRelativeDelta) {
          route.store!.record({
            ts: context.options.now(),
            kind: 'error', revision: route.revision ?? 0, side: 'canary', actor: request.principal.actor, question,
            detail: `quality: total moved ${(moved * 100).toFixed(2)}% (canary ${canaryTotal.toFixed(2)} vs stable ${stableTotal.toFixed(2)}), limit ${(route.qualityGuard.maxRelativeDelta * 100).toFixed(2)}%`,
          });
          route.store!.autoRollbackAfterErrors({ actor: 'canary-guard', now: context.options.now() });
          return result;
        }
      }
    }
    if (guarded) {
      const shaped = result as unknown as { refusals?: unknown[]; plan?: unknown } | null;
      const refused = typeof shaped === 'object' && shaped !== null
        && Array.isArray(shaped.refusals) && shaped.refusals.length > 0 && shaped.plan === undefined;
      route.store!.record({
        ts: context.options.now(),
        kind: refused ? 'error' : 'answer',
        revision: route.revision ?? 0, side: 'canary', actor: request.principal.actor, question,
        ...(refused ? { detail: 'the canary revision refused a question the stable revision answers' } : {}),
      });
      if (refused) route.store!.autoRollbackAfterErrors({ actor: 'canary-guard', now: context.options.now() });
    }
    return result;
  } catch (error) {
    if (route.side === 'canary') {
      route.store!.record({ kind: 'error', revision: route.revision ?? 0, side: 'canary', actor: request.principal.actor, question, detail: (error as Error).message.slice(0, 300) });
      route.store!.autoRollbackAfterErrors({ actor: 'canary-guard' });
    }
    throw error;
  }
}

/** The warehouse as the model sees it, for the drift check. */
function liveTables(context: Context): LiveTable[] {
  return withDatabase(context, (_run, catalog) => catalog.tables.map((table) => ({
    name: table.name,
    columns: table.columns.map((column) => ({ name: column.name, type: column.dataType })),
  })));
}

/** Events with their features over the newest `months` months, shaped for the rule-set analysis. */
function loadRiskEvents(run: QueryRunner, months: number): Parameters<typeof analyseRuleSet>[0]['events'] {
  const all = run('SELECT event_id, event_date, amount, is_fraud FROM risk_event ORDER BY event_date, event_id').rows;
  const dates = [...new Set(all.map((row) => String(row.event_date).slice(0, 7)))].sort();
  const window = new Set(dates.slice(-Math.max(1, months)));
  const features = run('SELECT event_id, feature_name, value FROM feature_snapshot').rows;
  const byEvent = new Map<string, Record<string, number>>();
  for (const row of features) {
    const entry = byEvent.get(String(row.event_id)) ?? {};
    entry[String(row.feature_name)] = Number(row.value);
    byEvent.set(String(row.event_id), entry);
  }
  return all
    .filter((row) => window.has(String(row.event_date).slice(0, 7)))
    .map((row) => ({
      id: String(row.event_id),
      date: String(row.event_date),
      window: String(row.event_date).slice(0, 7),
      label: (Number(row.is_fraud) === 1 ? 1 : 0) as 0 | 1,
      features: byEvent.get(String(row.event_id)) ?? {},
      fields: { amount: Number(row.amount) },
    }));
}

/** `withDatabase` for a handler that has to await between the read and the answer. */
async function withDatabaseAsync<T>(context: Context, fn: (run: QueryRunner) => Promise<T> | T): Promise<T> {
  const dbPath = join(context.options.fixtures, 'data', 'demo.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const runner = sqliteRunner(db, { rowLimit: 200_000, timeoutMs: 60_000 });
    return await fn((sql: string) => {
      assertReadOnly(sql);
      return runner(sql);
    });
  } finally {
    db.close();
  }
}

/**
 * Where a write-back goes.
 *
 * Without a platform endpoint configured there is nothing honest to commit to: a "committed" receipt that never left
 * the process would be the exact failure this module exists to prevent. So the dry-run adapter is the default, and a
 * real commit requires `PAGENT_WRITEBACK_URL` - an endpoint that accepts the payload and returns a receipt.
 */
function writebackAdapter(context: Context, platform: string): PlatformAdapter {
  const url = process.env.PAGENT_WRITEBACK_URL;
  if (!url) {
    const dry = dryRunAdapter(platform);
    return {
      name: platform,
      validate: dry.validate,
      commit: async () => {
        throw new HttpError(501, 'no-writeback-endpoint',
          'no platform endpoint is configured (PAGENT_WRITEBACK_URL)',
          'the payload and its idempotency key are valid; set the endpoint to commit');
      },
    };
  }
  void context;
  return {
    name: platform,
    validate: (payload: WritebackPlan) => payload.cells.length === 0
      ? [{ code: 'total-mismatch', detail: 'an empty payload is not a plan' }]
      : [],
    commit: async (payload: WritebackPlan) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': payload.idempotencyKey },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      if (!response.ok) throw new HttpError(502, 'platform-rejected', `the platform answered ${response.status}: ${text.slice(0, 300)}`);
      const parsed = JSON.parse(text || '{}') as { receiptId?: string; acceptedAt?: string };
      return { receiptId: parsed.receiptId ?? payload.idempotencyKey, acceptedAt: parsed.acceptedAt ?? context.options.now() };
    },
  };
}

async function askHandler(request: Request, context: Context): Promise<unknown> {
  const question = requireString(request.body, 'question');
  const decision = route(question);
  if (decision.agent === null) {
    return { mode: 'clarify', decision, note: 'the router refused to pick: ask the user which agent they meant' };
  }
  switch (decision.agent) {
    case 'semantic': {
      const { report } = loadModel(context);
      return { agent: 'semantic', decision, report, note: 'a build/report question, not an answer' };
    }
    case 'attribution': {
      const metric = String(request.body.metric ?? decision.signature.metrics[0] ?? 'spend');
      const from = String(request.body.from ?? '2025-10');
      const to = String(request.body.to ?? '2025-11');
      return confirmable(request, 'attribute', { metric, from, to, depth: 2 }, executeAttribute, context);
    }
    case 'campaign':
      return confirmable(request, 'campaign', { budget: null, maxChangePct: null }, executeCampaign, context);
    case 'risk':
      return executeRisk(context, {});
    case 'ask':
    default: {
      // the base answers factual questions from its own semantic layer; this service does not re-implement it
      const client = new GraphClient(context.config.phoenix);
      const answer = await client.callTool('ask_data', {
        graph: 'tpc-h-analytics', question, mode: request.body.mode === 'confirm' ? 'auto' : 'auto',
      });
      return { agent: 'ask', decision, answer };
    }
  }
}
