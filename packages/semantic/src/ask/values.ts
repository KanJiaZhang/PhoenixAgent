/**
 * The value vocabulary: which words a person types are a slice of a dimension.
 *
 * Without it "华东" is just an unrecognised token and the question is answered for *everyone* - a correct number to a
 * different question, and the failure this repository least wants. With it, "华东" becomes `region = '华东'`, which is
 * the same predicate §4.5 already renders and the same one the canary routes on.
 *
 * Where the values come from matters, so it is written down per dimension:
 *
 * | dimension looks like | values are read from | why |
 * | --- | --- | --- |
 * | a plain text column (`channel_type`) | `SELECT DISTINCT <column>` | the column *is* the value |
 * | a foreign key (`fact.region_id` -> `dim_region.region_id`) | the target table's `*_name` column | the id is the join, not the word a person types |
 * | a derived expression (month from a date) | nothing | a time dimension is not an enumeration |
 *
 * Two refusals are built in, because an enumeration is a claim: a foreign key whose target has no obvious label
 * column is refused (the model has to say which column carries the word), and a value that appears under two
 * dimensions is refused rather than guessed ("直营" could be a channel or an ownership type).
 */

import type { ModelIndex } from '../sql.ts';
import type { QueryRunner } from '../../../dataplane/src/sqlite.ts';
import { appendJsonl, readJson, readJsonl, writeJson } from '../../../core/src/workspace.ts';
import { join } from 'node:path';

export interface DimensionValues {
  dimension: string;
  name: string;
  /** The column the words come from, as `table.column`, so a reviewer can check it. */
  source: string;
  values: string[];
  /** The statement that produced them. */
  sql: string;
  /** How the source was chosen, when it was not the bound column itself. */
  note?: string;
}

export interface ValueVocabulary {
  graph: string;
  builtAt: string;
  dimensions: DimensionValues[];
  /** Dimensions that could not be enumerated, with the reason. */
  skipped: { dimension: string; reason: string }[];
}

export interface BuildValuesOptions {
  index: ModelIndex;
  run: QueryRunner;
  graph: string;
  /** Where the vocabulary artifact lives; required by `refreshVocabulary`. */
  workspace?: string;
  maxValues?: number;
  /** Only these dimensions, when a caller wants a subset. */
  dimensionIds?: string[];
  now?: string;
}

export function buildValueVocabulary(options: BuildValuesOptions): ValueVocabulary {
  const maxValues = options.maxValues ?? 50;
  const wanted = options.dimensionIds ? new Set(options.dimensionIds) : null;
  const dimensions: DimensionValues[] = [];
  const skipped: { dimension: string; reason: string }[] = [];

  for (const dimension of options.index.dimensions) {
    if (wanted && !wanted.has(dimension.id)) continue;
    const payload = dimension.payload;
    // a derived expression (month/quarter/year over a date) is not an enumeration
    if (payload.expression) {
      skipped.push({ dimension: dimension.id, reason: 'a derived expression is not an enumeration' });
      continue;
    }
    const columnId = payload.column;
    if (!columnId) {
      skipped.push({ dimension: dimension.id, reason: 'the dimension has no bound column' });
      continue;
    }
    const bound = options.index.columns.get(stripPrefix(columnId));
    if (bound && /date|time/i.test(bound.dataType)) {
      skipped.push({ dimension: dimension.id, reason: 'a date is a point in time, not an enumeration' });
      continue;
    }
    const source = valueColumnOf(options.index, columnId);
    if (!source) {
      skipped.push({
        dimension: dimension.id,
        reason: `no label column found for ${columnId}; declare one (the target table's *_name column) before values can be enumerated`,
      });
      continue;
    }
    const [table, column] = source.split('.') as [string, string];
    const sql = `SELECT DISTINCT ${quote(column)} AS value FROM ${quote(table)} WHERE ${quote(column)} IS NOT NULL ORDER BY 1 LIMIT ${maxValues}`;
    let rows: Record<string, unknown>[];
    try {
      rows = options.run(sql).rows;
    } catch (error) {
      skipped.push({ dimension: dimension.id, reason: `the enumeration failed: ${(error as Error).message.slice(0, 120)}` });
      continue;
    }
    const values = rows.map((row) => String(row.value)).filter((value) => value.length > 0);
    if (values.length === 0) {
      skipped.push({ dimension: dimension.id, reason: 'the enumeration returned no values' });
      continue;
    }
    dimensions.push({
      dimension: dimension.id,
      name: payload.name,
      source,
      values,
      sql,
      ...(source !== columnId.replace(/^column\//, '') ? { note: `followed ${columnId} to its label column` } : {}),
    });
  }

  return {
    graph: options.graph,
    builtAt: options.now ?? new Date().toISOString(),
    dimensions,
    skipped,
  };
}

export interface ValueDiff {
  added: { dimension: string; value: string }[];
  removed: { dimension: string; value: string }[];
  addedDimensions: string[];
  removedDimensions: string[];
  unchanged: number;
}

/**
 * What changed between the vocabulary in use and a fresh read of the warehouse.
 *
 * Values are facts, so a refresh adopts them; what changes is that the change is *visible* - an added region, a
 * channel that disappeared, a dimension that stopped being enumerable. Without this, a value silently stops being
 * answerable (or starts being) and nobody can tell when.
 */
export function diffVocabulary(previous: ValueVocabulary | null, next: ValueVocabulary): ValueDiff {
  const before = new Map((previous?.dimensions ?? []).map((entry) => [entry.dimension, new Set(entry.values)]));
  const after = new Map(next.dimensions.map((entry) => [entry.dimension, new Set(entry.values)]));
  const added: ValueDiff["added"] = [];
  const removed: ValueDiff["removed"] = [];
  let unchanged = 0;
  for (const [dimension, values] of after) {
    const old = before.get(dimension) ?? new Set<string>();
    for (const value of values) {
      if (old.has(value)) unchanged++;
      else added.push({ dimension, value });
    }
    for (const value of old) if (!values.has(value)) removed.push({ dimension, value });
  }
  return {
    added,
    removed,
    addedDimensions: [...after.keys()].filter((dimension) => !before.has(dimension)),
    removedDimensions: [...before.keys()].filter((dimension) => !after.has(dimension)),
    unchanged,
  };
}

export interface RefreshResult {
  vocabulary: ValueVocabulary;
  diff: ValueDiff;
  /** True when anything moved: a caller can decide whether that deserves a release note. */
  changed: boolean;
}

/**
 * Re-reads the warehouse and records what moved.
 *
 * The refresh is a decision like any other, so it goes on the timeline: "the vocabulary changed on this date, by this
 * much" is the question an auditor asks when a report suddenly shows a new region.
 */
export function refreshVocabulary(options: BuildValuesOptions & { actor: string; workspace: string }): RefreshResult {
  const previous = loadVocabulary(options.workspace, options.graph);
  const next = buildValueVocabulary(options);
  const diff = diffVocabulary(previous, next);
  const changed = diff.added.length > 0 || diff.removed.length > 0
    || diff.addedDimensions.length > 0 || diff.removedDimensions.length > 0;
  return { vocabulary: next, diff, changed };
}

/**
 * Which column carries the *word* a person types.
 *
 * A plain text column is its own vocabulary. A foreign key is not: `region_id = 3` is not something anyone says, so the
 * referenced table is followed and its label column (`*_name`, or `name`) is used. No label column means no
 * enumeration - guessing "the only VARCHAR" is how a reviewer ends up unable to explain where a value came from.
 */
function valueColumnOf(index: ModelIndex, columnId: string): string | null {
  // `index.columns` is keyed by `table.column`; dimensions point at `column/table.column`
  const bare = stripPrefix(columnId);
  const column = index.columns.get(bare);
  if (!column) return null;
  // a date is a point in time, not a category: enumerating it would be a 800-value drop-down
  if (/date|time/i.test(column.dataType)) return null;
  const isText = /char|text|clob/i.test(column.dataType);
  if (isText && column.columnRole !== 'PK') return `${column.table}.${column.name}`;

  const reference = index.references.find((edge) => edge.from === columnId || edge.from === bare);
  if (!reference) return null;
  const target = index.columns.get(stripPrefix(reference.to));
  if (!target) return null;
  // the referenced table's label columns: `x_name` first, then `name`
  const targetId = stripPrefix(reference.to);
  const siblings = [...index.columns.entries()]
    .filter(([id, entry]) => entry.table === target.table && id !== targetId)
    .map(([, entry]) => entry);
  const label = siblings.find((entry) => /_name$/i.test(entry.name))
    ?? siblings.find((entry) => /^name$/i.test(entry.name))
    ?? siblings.find((entry) => /char|text/i.test(entry.dataType) && entry.columnRole !== 'FK' && entry.columnRole !== 'PK');
  return label ? `${label.table}.${label.name}` : null;
}

// --- the vocabulary as a workspace artifact, plus reviewable aliases --------------------------------

export function valuesPath(workspace: string, graph: string): string {
  return join(workspace, 'values', `${graph}.json`);
}

export function aliasPath(workspace: string, graph: string): string {
  return join(workspace, 'values', `${graph}.aliases.jsonl`);
}

export function saveVocabulary(workspace: string, vocabulary: ValueVocabulary): void {
  writeJson(valuesPath(workspace, vocabulary.graph), vocabulary);
}

export function loadVocabulary(workspace: string, graph: string): ValueVocabulary | null {
  return readJson<ValueVocabulary>(valuesPath(workspace, graph));
}

export interface ValueAlias {
  word: string;
  dimension: string;
  value: string;
  actor: string;
  at: string;
  note: string;
}

export interface ValueSuppression {
  /** Either a word to never recognise, or a value to never recognise under one dimension. */
  word?: string;
  dimension?: string;
  value?: string;
  reason: string;
  actor: string;
  at: string;
}

export function suppressionPath(workspace: string, graph: string): string {
  return join(workspace, 'values', `${graph}.denylist.jsonl`);
}

export function loadSuppressions(workspace: string, graph: string): ValueSuppression[] {
  return readJsonl<ValueSuppression>(suppressionPath(workspace, graph));
}

/**
 * Marks a word or a value as not answerable.
 *
 * The vocabulary is measured, and a measurement does not know that a warehouse value is an internal code that must not
 * appear in a report. Suppression is that decision: it is recorded with a reason and an actor, it is applied before any
 * matching happens, and a question that names a suppressed word is refused rather than answered without it.
 */
export function suppressValue(options: {
  workspace: string; graph: string; vocabulary: ValueVocabulary;
  word?: string; dimension?: string; value?: string;
  reason: string; actor: string; now?: string;
}): ValueSuppression {
  const word = options.word?.trim();
  if (!word && !options.value) throw new Error('a suppression needs a word or a value');
  if (!options.reason.trim()) throw new Error('a suppression needs a reason: it is a decision about what may be answered');
  if (options.value) {
    const dimension = options.vocabulary.dimensions.find((entry) => entry.dimension === options.dimension || entry.name === options.dimension);
    if (!dimension) throw new Error();
    if (!dimension.values.includes(options.value)) {
      throw new Error();
    }
  }
  const entry: ValueSuppression = {
    ...(word ? { word } : {}),
    ...(options.value ? { dimension: options.dimension, value: options.value } : {}),
    reason: options.reason, actor: options.actor, at: options.now ?? new Date().toISOString(),
  };
  appendJsonl(suppressionPath(options.workspace, options.graph), entry);
  return entry;
}

export function loadAliases(workspace: string, graph: string): ValueAlias[] {
  return readJsonl<ValueAlias>(aliasPath(workspace, graph));
}

/**
 * Records "华东区 means 华东 in dim/region", after checking that the value exists.
 *
 * An alias is reviewable data, not code: it is appended with the actor and can be read back, which is the difference
 * between a vocabulary the business can audit and a synonym table buried in a prompt.
 */
export function addAlias(options: {
  workspace: string; graph: string; vocabulary: ValueVocabulary;
  word: string; dimension: string; value: string; actor: string; note?: string; now?: string;
}): ValueAlias {
  const word = options.word.trim();
  if (word.length < 2) throw new Error('an alias needs at least two characters');
  const dimension = options.vocabulary.dimensions.find((entry) => entry.dimension === options.dimension
    || entry.name === options.dimension);
  if (!dimension) throw new Error(`the vocabulary has no values for '${options.dimension}'`);
  if (!dimension.values.includes(options.value)) {
    throw new Error(`'${options.value}' is not a value of ${dimension.dimension}: ${dimension.values.slice(0, 8).join(', ')}`);
  }
  const existing = loadAliases(options.workspace, options.graph).filter((alias) => alias.word === word);
  if (existing.length > 0 && existing[existing.length - 1]!.value !== options.value) {
    throw new Error(`'${word}' already means ${existing[existing.length - 1]!.value}; re-pointing it needs a different decision`);
  }
  const alias: ValueAlias = {
    word, dimension: dimension.dimension, value: options.value, actor: options.actor,
    at: options.now ?? new Date().toISOString(), note: options.note ?? '',
  };
  appendJsonl(aliasPath(options.workspace, options.graph), alias);
  return alias;
}

// --- matching a question against the vocabulary ------------------------------------------------------

export interface ValueMatch {
  filters: { dimension: string; value: string }[];
  matched: string[];
  /** A value that belongs to more than one dimension, or an unknown word sitting where a value should be. */
  refusal?: { code: 'ambiguous-value' | 'unknown-value' | 'out-of-scope'; message: string; hint: string; candidates?: string[] };
}

/**
 * Finds the slices a question names.
 *
 * Two guards, both learned from the failure modes:
 *
 * - **ambiguity**: the same word under two dimensions is a refusal. Picking one silently is how "直营" (a channel) is
 *   answered as if it were an ownership type.
 * - **unknown value**: a question that names a dimension ("大区") but prefixes it with a word the vocabulary does not
 *   know ("火星大区") is refused with the value list. Answering it for all regions would be a correct number to a
 *   different question, which is the worst outcome available here.
 */
export function matchValues(question: string, index: ModelIndex, vocabulary: ValueVocabulary, aliases: ValueAlias[] = [],
  suppressions: ValueSuppression[] = []): ValueMatch {
  const text = question.trim();

  // a suppressed word is refused before anything else: answering without it would be a correct number to a question
  // nobody should be able to ask through this door
  const suppressed = suppressions.find((entry) => (entry.word && text.includes(entry.word))
    || (entry.value && text.includes(entry.value)));
  if (suppressed) {
    return {
      filters: [], matched: [],
      refusal: {
        code: 'out-of-scope',
        message: `「${suppressed.word ?? suppressed.value}」被屏蔽：${suppressed.reason}`,
        hint: '这个取值不允许通过问数获取；如果这是误判，撤销屏蔽需要一次审查决定',
      },
    };
  }
  const aliasHits = aliases.filter((alias) => text.includes(alias.word));
  const hits = new Map<string, { dimension: string; value: string }[]>();
  const matched: string[] = [];

  const add = (dimension: string, value: string, word: string) => {
    const list = hits.get(dimension) ?? [];
    if (!list.some((entry) => entry.value === value)) list.push({ dimension, value });
    hits.set(dimension, list);
    matched.push(word);
  };
  for (const alias of aliasHits) add(alias.dimension, alias.value, alias.word);
  for (const dimension of vocabulary.dimensions) {
    for (const value of dimension.values) {
      if (value.length < 2 || !text.includes(value)) continue;
      // an alias already claimed this stretch of text for the same value
      if (aliasHits.some((alias) => alias.word === value && alias.value === value)) continue;
      add(dimension.dimension, value, value);
    }
  }

  if (hits.size > 1) {
    const names = [...hits.keys()];
    return {
      filters: [], matched,
      refusal: {
        code: 'ambiguous-value',
        message: `「${[...new Set(matched)].join('」「')}」同时是 ${names.join(' 与 ')} 的取值`,
        hint: '请指明是哪个维度：例如「大区=华东」或「渠道=华东」',
        candidates: names,
      },
    };
  }

  const filters = [...hits.values()].flat();

  // the prefix check: "火星大区" names the dimension with a value it does not have
  if (filters.length === 0) {
    for (const dimension of vocabulary.dimensions) {
      const entry = index.dimensions.find((candidate) => candidate.id === dimension.dimension);
      // the word a person types may be the dimension's name or one of its aliases ('大区' for 'region')
      const labels = [entry?.payload.name ?? dimension.name, ...(entry?.payload.alias ?? [])]
        .filter((label) => typeof label === 'string' && label.length >= 2)
        .sort((left, right) => right.length - left.length);
      const label = labels.find((candidate) => text.includes(candidate));
      if (!label) continue;
      const position = text.indexOf(label);
      if (position <= 0) continue;
      // up to four characters immediately before the dimension word, stopping at a digit or punctuation
      let start = position;
      while (start > 0 && position - start < 4 && !/[\d\s，,。？?、:：年月日]/.test(text[start - 1]!)) start--;
      const prefix = text.slice(start, position).trim();
      if (prefix.length < 2) continue;
      // a known metric/dimension word in that position is not a value attempt
      const known = [...index.metrics.map((metric) => metric.payload.name), ...index.dimensions.map((entry) => entry.payload.name)]
        .some((name) => name.length >= 2 && prefix.includes(name));
      if (known) continue;
      return {
        filters: [], matched,
        refusal: {
          code: 'unknown-value',
          message: `「${prefix}${label}」里的「${prefix}」不是 ${dimension.name} 的取值`,
          hint: `可用取值：${dimension.values.slice(0, 10).join('、')}`,
          candidates: dimension.values,
        },
      };
    }
  }

  return { filters, matched: [...new Set(matched)] };
}

function stripPrefix(columnId: string): string {
  return columnId.startsWith("column/") ? columnId.slice("column/".length) : columnId;
}

function quote(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`refusing to quote '${identifier}'`);
  return `"${identifier}"`;
}
