/**
 * Turns what the documents say into candidates, and resolves the names they use against what the SQL says.
 *
 * The document reader is deliberately the *weakest* source in the pipeline, and this file makes that
 * structural rather than a matter of good intentions:
 *
 * - A mention that resolves to a metric or dimension found in the DDL/ETL corpus **enriches** it (aliases,
 *   description, an attribution edge) at confidence 0.85. It does not create it.
 * - A mention that resolves to nothing becomes a `needs_review` candidate with the sentence it came from.
 *   It is not dropped, because a wiki that names a metric the warehouse has never heard of is precisely the
 *   coverage gap this product exists to surface.
 * - A mention that states a formula for a metric the SQL defines differently is not resolved silently: the
 *   formula travels with the candidate and `merge` raises the conflict.
 *
 * Two deterministic readers are here (the pattern reader and this resolver). The model-assisted reader is
 * `docs-llm.ts`, and it produces the same shapes with `provenance: 'llm'` and a lower confidence, so
 * nothing downstream needs to know which one spoke.
 */

import { extractDocMentions, type DocMention } from '../../../dataplane/src/docs.ts';
import {
  dimId,
  domainId,
  metricId,
  relationId,
  shortId,
  slug,
  type Candidate,
  type DimensionPayload,
  type MetricPayload,
} from '../../../contracts/src/index.ts';

export interface DocExtraction {
  candidates: Candidate[];
  notes: string[];
}

/**
 * `known` is what the DDL and ETL readers have already produced; mentions resolve against it.
 *
 * `kind` is the evidence kind, because a PDF's text layer is not a wiki page: the review screen should say
 * which document a description came from, not flatten both into "documentation".
 */
export function extractFromDocs(sourceFile: string, text: string, known: Candidate[],
  kind: 'wiki' | 'pdf' = 'wiki'): DocExtraction {
  const frontMatter = parseFrontMatter(text);
  const mentions = extractDocMentions(sourceFile, text);
  const firstPass = buildResolver(known);
  const candidates: Candidate[] = [];
  const notes: string[] = [];

  // The document's own vocabulary becomes resolvable before its sentences are read. A line that says
  // 「归因收入（revenue）」 defines the word it then uses in 「ROI 由 归因收入 与 投放花费 共同决定」; without this
  // pass that sentence's drivers look like unknown terms and the attribution edge is silently lost.
  const vocabulary = new Map<string, Candidate>();
  for (const mention of mentions) {
    const target = firstPass(mention.name, mention.aliases);
    if (!target) continue;
    vocabulary.set(normalizeName(mention.name), target);
    for (const alias of mention.aliases) vocabulary.set(normalizeName(alias), target);
  }
  const resolver = buildResolver(known, vocabulary);
  // A document can declare the domain it governs, in front matter:
  //
  //   ---
  //   domain: 投放域
  //   ---
  //
  // Everything it resolves in this file then belongs to that domain, which is what makes "which metrics are
  // ours" answerable without reading a wiki by hand.
  const touched: string[] = [];

  for (const mention of mentions) {
    const target = resolver(mention.name, mention.aliases);

    if (mention.kind === 'contribution') {
      if (!target || target.entityType !== 'metric') {
        notes.push(`${sourceFile}: contribution sentence names '${mention.name}', which no metric matches`);
        continue;
      }
      for (const driver of mention.drivers ?? []) {
        const source = resolver(driver, []);
        if (!source || source.entityType !== 'metric') {
          notes.push(`${sourceFile}: driver '${driver}' of '${mention.name}' does not match a metric`);
          continue;
        }
        candidates.push({
          id: relationId(source.id, 'contributesTo', target.id),
          kind: 'relation',
          relationType: 'contributesTo',
          from: source.id,
          to: target.id,
          payload: { statedIn: 'document' },
          provenance: 'parser',
          confidence: 0.85,
          evidence: [evidence(sourceFile, mention)],
          status: 'candidate',
        });
      }
      continue;
    }

    if (target) {
      // enrichment: same id, weaker provenance, no new structure
      const payload: Record<string, unknown> = {};
      if (mention.description) payload.description = mention.description;
      const aliases = unique([mention.name, ...mention.aliases]);
      if (aliases.length > 0) payload.alias = aliases;
      if (mention.kind === 'definition' && mention.formula && target.entityType === 'metric') {
        payload.expression = mention.formula;
      }
      candidates.push({
        id: target.id,
        kind: 'entity',
        entityType: target.entityType,
        payload,
        provenance: 'parser',
        confidence: 0.85,
        evidence: [evidence(sourceFile, mention, kind)],
        status: 'candidate',
      });
      if (target.entityType === 'metric' || target.entityType === 'dimension') touched.push(target.id);
      continue;
    }

    // --- nothing matched: keep it, flag it, and say why
    const isDimension = mention.dimension || /维度/.test(mention.heading);
    // Prefer an ASCII alias for the id when the document gives one: 「捕获率（capture_rate）」 should become
    // `metric/capture_rate`, not `metric/捕获率`, so ids stay stable across a rename of the Chinese label.
    const asciiAlias = mention.aliases.find((alias) => /^[A-Za-z_][\w-]*$/.test(alias));
    const id = isDimension ? dimId(asciiAlias ?? mention.name) : metricId(asciiAlias ?? mention.name);
    const payload: MetricPayload | DimensionPayload = isDimension
      ? { name: mention.name, description: mention.description, alias: mention.aliases }
      : {
          name: asciiAlias ?? mention.name,
          expression: mention.formula ?? '',
          aggFunction: aggregateOf(mention.formula),
          metricKind: 'base',
          description: mention.description,
          alias: unique([mention.name, ...mention.aliases]),
          tables: [],
          columns: [],
        };
    candidates.push({
      id,
      kind: 'entity',
      entityType: isDimension ? 'dimension' : 'metric',
      payload,
      provenance: 'parser',
      confidence: 0.4,
      evidence: [evidence(sourceFile, mention, kind)],
      status: 'needs_review',
      note: `文档提到「${mention.name}」，但 DDL/ETL 里没有对应的${isDimension ? '维度' : '指标'}定义`,
    });
  }

  if (frontMatter.domain && touched.length > 0) {
    const domain = domainId(frontMatter.domain);
    candidates.push({
      id: domain,
      kind: 'entity',
      entityType: 'domain',
      payload: { name: frontMatter.domain, description: `${frontMatter.domain}：由 ${sourceFile} 声明的业务域` },
      provenance: 'parser',
      confidence: 0.9,
      evidence: [{ kind, sourceFile, span: frontMatter.span, quote: frontMatter.raw }],
      status: 'candidate',
    });
    for (const id of unique(touched)) {
      candidates.push({
        id: relationId(id, 'belongsTo', domain),
        kind: 'relation',
        relationType: 'belongsTo',
        from: id,
        to: domain,
        payload: { statedIn: 'document' },
        provenance: 'parser',
        confidence: 0.9,
        evidence: [{ kind, sourceFile, span: frontMatter.span, quote: frontMatter.raw }],
        status: 'candidate',
      });
      if (id.startsWith('metric/')) {
        candidates.push({
          id: relationId(domain, 'hasMetric', id),
          kind: 'relation',
          relationType: 'hasMetric',
          from: domain,
          to: id,
          payload: { statedIn: 'document' },
          provenance: 'parser',
          confidence: 0.9,
          evidence: [{ kind, sourceFile, span: frontMatter.span, quote: frontMatter.raw }],
          status: 'candidate',
        });
      }
    }
  }

  return { candidates, notes };
}

/**
 * `---`-fenced front matter, read as `key: value` pairs.
 *
 * Deliberately not a YAML parser: the keys a document needs to declare are `domain` and `owner`, and a
 * dependency that parses YAML to read two strings would be a bug surface for nothing.
 */
function parseFrontMatter(text: string): { domain?: string; owner?: string; span: [number, number]; raw: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { span: [0, 0], raw: '' };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (pair) fields[pair[1]!] = pair[2]!;
  }
  return {
    domain: fields.domain,
    owner: fields.owner,
    span: [0, match[0].length],
    raw: match[0],
  };
}

/** Resolves a written name to the known entity it most likely means, or null. Never guesses between two. */
function buildResolver(known: Candidate[], vocabulary?: Map<string, Candidate>): (name: string, aliases: string[]) => Candidate | null {
  // keyed by candidate *id*: the same dimension arrives from a file per report, and two copies of one
  // dimension must not look like two dimensions that merely share a name.
  const index = new Map<string, Map<string, Candidate>>();
  const add = (key: string, candidate: Candidate): void => {
    const normalized = normalizeName(key);
    if (normalized.length === 0) return;
    const entries = index.get(normalized) ?? new Map<string, Candidate>();
    entries.set(candidate.id, candidate);
    index.set(normalized, entries);
  };

  for (const candidate of known) {
    if (candidate.kind !== 'entity') continue;
    if (!['metric', 'dimension', 'table', 'column'].includes(candidate.entityType ?? '')) continue;
    add(shortId(candidate.id), candidate);
    const payload = candidate.payload as { name?: string; alias?: string[] };
    if (payload.name) add(payload.name, candidate);
    for (const alias of payload.alias ?? []) add(alias, candidate);
  }
  for (const [key, candidate] of vocabulary ?? []) add(key, candidate);

  return (name, aliases) => {
    for (const key of [name, ...aliases]) {
      const matches = [...(index.get(normalizeName(key))?.values() ?? [])];
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        // two entities claim the same word: prefer a metric if exactly one is, otherwise refuse and let the
        // review queue show both
        const metrics = matches.filter((m) => m.entityType === 'metric');
        if (metrics.length === 1) return metrics[0]!;
        return null;
      }
    }
    return null;
  };
}

function normalizeName(name: string): string {
  return slug(name);
}

function aggregateOf(formula: string | undefined): MetricPayload['aggFunction'] {
  const head = /^\s*(sum|count|avg)\s*\(/i.exec(formula ?? '')?.[1]?.toUpperCase();
  return head === 'COUNT' ? 'COUNT' : head === 'AVG' ? 'AVG' : 'SUM';
}

function evidence(sourceFile: string, mention: DocMention, kind: 'wiki' | 'pdf' = 'wiki'): Candidate['evidence'][number] {
  return { kind, sourceFile, span: mention.span, quote: mention.quote };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
