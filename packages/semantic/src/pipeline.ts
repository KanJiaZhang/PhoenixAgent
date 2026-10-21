/**
 * The build: sources in, a reported and reviewable model out.
 *
 * The order matters and is the design:
 *
 * 1. **DDL and ETL first** (`parser`, deterministic), because they are the only sources that can be trusted
 *    without a model. They produce the nouns (tables, columns) and, more importantly, the verbs (aggregate →
 *    metric, `GROUP BY` → dimension, `ON` → join, `WHERE status='paid'` → 口径).
 * 2. **The catalog and a profile second** (`catalog`, measured): grain, undeclared keys, the columns that are
 *    really dimensions, time levels, and personal data. Documents cannot supply these, and no report may need
 *    to have grouped by a column for it to be a dimension.
 * 3. **Documents last** (wiki and PDF), resolved *against* what steps 1-2 produced, so a document can only
 *    enrich or disagree - never invent a metric nothing computes.
 * 4. **Merge**, where disagreements become conflicts instead of being averaged away.
 * 5. **Probe**, against the real warehouse, because a model that has never been run is a hypothesis.
 * 6. **Evaluate**, which is the only step allowed to say "this is publishable", and which also says what is
 *    still missing (per-table completeness, orphans, and the diff since the last build).
 *
 * Every step leaves its artifacts in the workspace, keyed by graph name, and the whole thing is deterministic
 * given the same inputs and the same `now` - the report is meant to be diffed.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { listFiles, readJson, writeJson, ensureDir } from '../../core/src/workspace.ts';
import type { LlmGateway } from '../../core/src/llm.ts';
import type { Candidate, QualityReport, Revision } from '../../contracts/src/index.ts';
import { readSqliteCatalog, sqliteRunner, type Catalog } from '../../dataplane/src/sqlite.ts';
import { profileCatalog, type TableProfile } from '../../dataplane/src/profile.ts';
import { extractPdfText } from '../../dataplane/src/pdf.ts';
import { assertReadOnly } from '../../dataplane/src/guard.ts';
import { extractFromDdl } from './extract/ddl.ts';
import { extractFromEtl } from './extract/etlsql.ts';
import { extractFromCatalog } from './extract/catalog.ts';
import { extractFromDocs } from './extract/docs.ts';
import { resolveCrossFactMetrics } from './derive.ts';
import { EMPTY_SCOPE, scopeCandidates, scopeCatalog, type Scope } from './scope.ts';
import { indexModel } from './sql.ts';
import { mergeCandidates, type Conflict, type MergedCandidate } from './merge.ts';
import { runProbes } from './probes.ts';
import { evaluate } from './evaluate.ts';
import { ReviewLog, applyRevisions } from './review.ts';

export interface BuildOptions {
  fixtures: string;
  graph: string;
  workspace: string;
  /** A fixed timestamp, so two builds of the same inputs produce the same bytes. */
  now: string;
  includeInjected?: boolean;
  llm?: LlmGateway;
  coverageFloors?: { columnsDocumented?: number; metricsDefined?: number };
}

export interface SourceFile {
  kind: 'ddl' | 'etl' | 'wiki' | 'pdf';
  /** Path relative to the fixtures root: `ddl/warehouse.sql`. */
  path: string;
  /** Present when the source was read. */
  text?: string;
}

/** A source that exists and was not read, with the reason. Reported, never silently dropped. */
export interface UnreadSource {
  kind: string;
  path: string;
  reason: string;
}

export interface BuildOutcome {
  graph: string;
  modelVersion: number;
  candidates: MergedCandidate[];
  /** After the review log is applied: what would be published today. */
  reviewed: MergedCandidate[];
  conflicts: Conflict[];
  report: QualityReport;
  notes: string[];
  sourceFiles: SourceFile[];
  unread: UnreadSource[];
  catalog: Catalog;
  revisions: Revision[];
}

export function readSources(fixtures: string, includeInjected = false): { files: SourceFile[]; unread: UnreadSource[] } {
  const roots = includeInjected ? [fixtures, join(fixtures, 'injected')] : [fixtures];
  const files: SourceFile[] = [];
  const unread: UnreadSource[] = [];

  for (const root of roots) {
    const prefix = root === fixtures ? '' : 'injected/';
    for (const [kind, folder, extension] of [
      ['ddl', 'ddl', '.sql'],
      ['etl', 'etl', '.sql'],
      ['wiki', 'wiki', '.md'],
    ] as const) {
      for (const path of listFiles(join(root, folder), extension)) {
        const relative = path.slice(join(root, folder).length + 1).replace(/\\/g, '/');
        files.push({ kind, path: `${prefix}${folder}/${relative}`, text: readFileSync(path, 'utf8') });
      }
    }
    for (const path of listFiles(join(root, 'docs'), '.pdf')) {
      const relative = path.slice(join(root, 'docs').length + 1).replace(/\\/g, '/');
      const sourcePath = `${prefix}docs/${relative}`;
      const extraction = extractPdfText(readFileSync(path));
      if (extraction.readable) {
        files.push({ kind: 'pdf', path: sourcePath, text: extraction.text });
      } else {
        // recorded with the reason, so the report says what it could not see and why
        unread.push({ kind: 'pdf', path: sourcePath, reason: extraction.note || 'the text layer could not be read' });
      }
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, unread };
}

/** Runs the whole build without touching the workspace. Pure enough to unit-test. */
export function buildModel(options: BuildOptions): BuildOutcome {
  const { files, unread } = readSources(options.fixtures, options.includeInjected);
  const notes: string[] = [];
  const dbPath = join(options.fixtures, 'data', 'demo.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const scope: Scope = readJson<Scope>(join(options.fixtures, 'scope.json')) ?? EMPTY_SCOPE;
    const catalog = scopeCatalog(readSqliteCatalog(db, dbPath), scope);
    if (scope.excludeTables.length > 0) {
      notes.push(`scope: 排除 ${scope.excludeTables.join(', ')}（${scope.reason ?? '见 scope.json'}）`);
    }
    const run = sqliteRunner(db, { rowLimit: 1000, timeoutMs: 30_000 });
    const guardedRun = (sql: string) => {
      assertReadOnly(sql);
      return run(sql);
    };

    // --- 1. deterministic sources
    const fromDdl: Candidate[] = [];
    const fromEtl: Candidate[] = [];
    const docsSource: { path: string; text: string; kind: 'wiki' | 'pdf' }[] = [];

    for (const file of files) {
      if (file.kind === 'ddl') {
        const extraction = extractFromDdl(file.path, file.text!);
        fromDdl.push(...extraction.candidates);
        notes.push(...extraction.notes);
        // a DDL file also carries views, which are named queries: the SQL reader has to see them too
        const views = extractFromEtl(file.path, file.text!, catalog);
        fromEtl.push(...views.candidates.filter((candidate) => candidate.entityType === 'query'
          || candidate.relationType === 'derivedFrom' || candidate.relationType === 'definedBy'
          || candidate.entityType === 'metric' || candidate.relationType === 'usesColumn'
          || candidate.relationType === 'computedFrom' || candidate.relationType === 'groupedBy'
          || candidate.relationType === 'dimensionColumn'));
        notes.push(...views.notes);
      } else if (file.kind === 'etl') {
        const extraction = extractFromEtl(file.path, file.text!, catalog);
        fromEtl.push(...extraction.candidates);
        notes.push(...extraction.notes);
      } else if (file.kind === 'wiki' || file.kind === 'pdf') {
        docsSource.push({ path: file.path, text: file.text!, kind: file.kind });
      }
    }

    // --- 2. measured sources: grain, undeclared keys, dimensions, time levels, sensitivity
    const profiles: TableProfile[] = profileCatalog(guardedRun, catalog);
    const catalogExtraction = extractFromCatalog(catalog, profiles, [...fromDdl, ...fromEtl]);
    const fromCatalog = catalogExtraction.candidates;
    notes.push(...catalogExtraction.notes);

    // --- 3. documents resolve against everything above
    const fromDocs: Candidate[] = [];
    for (const doc of docsSource) {
      const extraction = extractFromDocs(doc.path, doc.text, [...fromDdl, ...fromEtl, ...fromCatalog], doc.kind);
      fromDocs.push(...extraction.candidates);
      notes.push(...extraction.notes);
    }

    // --- 3b. the domain boundary: candidates that name an excluded table never reach the merge
    const scoped = scopeCandidates([...fromDdl, ...fromEtl, ...fromCatalog, ...fromDocs], scope);
    if (scoped.dropped.length > 0) {
      notes.push(`scope: 丢弃 ${scoped.dropped.length} 个候选（属于被排除的表）`);
    }

    // --- 4. merge: agreements consolidate, disagreements become conflicts
    const merged = mergeCandidates(scoped.candidates);
    notes.push(...merged.notes);

    // --- 4b. a document may define a metric over two facts; resolve it to a cross-fact ratio or leave it for review
    const derived = resolveCrossFactMetrics(merged.merged, indexModel(merged.merged));
    notes.push(...derived.notes);

    // --- 5. the review log, if there is one, decides the open questions
    const reviewLog = new ReviewLog(join(options.workspace, 'reviews', `${options.graph}.jsonl`));
    const revisions = reviewLog.all();
    const reviewed = applyRevisions(merged.merged, revisions);

    // --- 6. probes, against the warehouse
    const goldens = readJson<{ metrics?: Record<string, number> }>(join(options.fixtures, 'goldens.json'));
    const probes = runProbes({
      run: guardedRun,
      catalog,
      candidates: reviewed,
      goldens: goldens ?? undefined,
    });

    // --- 7. evaluate
    const modelVersion = nextModelVersion(options.workspace, options.graph);
    const report = evaluate({
      graph: options.graph,
      modelVersion,
      generatedAt: options.now,
      candidates: reviewed,
      probes,
      conflicts: merged.conflicts,
      catalog,
      profiles,
      sourceFiles: files.map((file) => ({ kind: file.kind, path: file.path })),
      unread,
      notes,
      coverageFloors: options.coverageFloors,
    });

    return {
      graph: options.graph,
      modelVersion,
      candidates: merged.merged,
      reviewed,
      conflicts: merged.conflicts,
      report,
      notes,
      sourceFiles: files,
      unread,
      catalog,
      revisions,
    };
  } finally {
    db.close();
  }
}

/** Builds and writes `candidates.json` + `report.json`, which is what `report`, `review` and `publish` read. */
export function build(options: BuildOptions): BuildOutcome {
  const previous = readJson<{ candidates: MergedCandidate[] }>(
    join(options.workspace, 'build', options.graph, 'candidates.json'));
  const outcome = buildModel(options);
  if (previous?.candidates) {
    // what changed since the last build of this graph: the report is a diff, not only a snapshot
    outcome.report.drift = diffCandidates(previous.candidates, outcome.candidates);
  }
  const buildDir = join(options.workspace, 'build', options.graph);
  ensureDir(buildDir);
  writeJson(join(buildDir, 'candidates.json'), {
    graph: outcome.graph,
    generatedAt: options.now,
    candidates: outcome.candidates,
    conflicts: outcome.conflicts,
    notes: outcome.notes,
    sourceFiles: outcome.sourceFiles.map((file) => ({ kind: file.kind, path: file.path })),
    unread: outcome.unread,
  });
  writeJson(join(buildDir, 'report.json'), outcome.report);
  return outcome;
}

/** Added, removed and changed candidates, by id. A changed payload counts as changed. */
export function diffCandidates(previous: MergedCandidate[], current: MergedCandidate[]): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const before = new Map(previous.map((candidate) => [candidate.id, JSON.stringify(candidate.payload)]));
  const after = new Map(current.map((candidate) => [candidate.id, JSON.stringify(candidate.payload)]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, payload] of after) {
    if (!before.has(id)) added.push(id);
    else if (before.get(id) !== payload) changed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, removed, changed };
}

/** Reads the last build back, for `report` / `review` / `publish`, without re-running the extractors. */
export function loadBuild(options: Pick<BuildOptions, 'fixtures' | 'graph' | 'workspace' | 'now'>): {
  candidates: MergedCandidate[];
  conflicts: Conflict[];
  notes: string[];
  sourceFiles: { kind: string; path: string }[];
  unread?: UnreadSource[];
} | null {
  const buildDir = join(options.workspace, 'build', options.graph);
  const stored = readJson<{
    candidates: MergedCandidate[];
    conflicts: Conflict[];
    notes: string[];
    sourceFiles: { kind: string; path: string }[];
    unread?: UnreadSource[];
  }>(join(buildDir, 'candidates.json'));
  if (!stored) return null;
  // The review log is the source of truth for status: a candidate a person accepted must read as accepted to
  // every consumer (the query surface, the agents), not only inside the report.
  const reviewed = applyRevisions(stored.candidates, new ReviewLog(join(options.workspace, 'reviews', `${options.graph}.jsonl`)).all());
  return { ...stored, candidates: reviewed };
}

/** Re-evaluates the stored build with the review log applied. No extraction, so it is fast. */
export function rebuildReport(options: BuildOptions): BuildOutcome {
  const stored = loadBuild(options);
  if (!stored) {
    throw new Error(`no build for '${options.graph}' in ${options.workspace}; run 'build' first`);
  }
  const dbPath = join(options.fixtures, 'data', 'demo.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const catalog = readSqliteCatalog(db, dbPath);
    const run = sqliteRunner(db, { rowLimit: 1000, timeoutMs: 30_000 });
    const guardedRun = (sql: string) => {
      assertReadOnly(sql);
      return run(sql);
    };
    const reviewLog = new ReviewLog(join(options.workspace, 'reviews', `${options.graph}.jsonl`));
    const revisions = reviewLog.all();
    const reviewed = applyRevisions(stored.candidates, revisions);
    const goldens = readJson<{ metrics?: Record<string, number> }>(join(options.fixtures, 'goldens.json'));
    const profiles = profileCatalog(guardedRun, catalog);
    const probes = runProbes({
      run: guardedRun,
      catalog,
      candidates: reviewed,
      goldens: goldens ?? undefined,
    });
    const report = evaluate({
      graph: options.graph,
      modelVersion: nextModelVersion(options.workspace, options.graph),
      generatedAt: options.now,
      candidates: reviewed,
      probes,
      conflicts: stored.conflicts,
      catalog,
      profiles,
      sourceFiles: stored.sourceFiles,
      unread: stored.unread ?? [],
      notes: stored.notes,
      coverageFloors: options.coverageFloors,
    });
    writeJson(join(options.workspace, 'build', options.graph, 'report.json'), report);
    return {
      graph: options.graph,
      modelVersion: report.modelVersion,
      candidates: stored.candidates,
      reviewed,
      conflicts: stored.conflicts,
      report,
      notes: stored.notes,
      sourceFiles: [],
      unread: stored.unread ?? [],
      catalog,
      revisions,
    };
  } finally {
    db.close();
  }
}

export function nextModelVersion(workspace: string, graph: string): number {
  const dir = join(workspace, 'models', graph);
  // `v3.json` is a revision; `v3.graph.json` is its analytical export and must not be counted twice
  const versions = listFiles(dir, '.json')
    .map((path) => /v(\d+)\.json$/.exec(path)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}
