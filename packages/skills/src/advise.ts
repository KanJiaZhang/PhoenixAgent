/**
 * Retrieval, and the one place a tip is allowed to change behaviour.
 *
 * Two hard rules, then a ranking:
 *
 * 1. **Scope is a filter.** A tip scoped to `postgres` is not offered to a `sqlite` query, and a tip scoped to
 *    `fact_order` is not offered to a query that never reads it. This is where a skill system usually goes
 *    wrong: a global prompt makes every tip apply everywhere, and a `LIMIT` trick learned on one warehouse
 *    becomes advice for all of them.
 * 2. **Deprecated tips are invisible.** A retired tip is kept for the audit trail, not served.
 *
 * Then ranking by {@link SkillStore.score}: confidence × the tip's own hit rate × adoption. An adopted tip
 * that has been right nine times out of ten outranks a candidate that has never been contradicted, because
 * the candidate has never been tested.
 *
 * The matching itself is deterministic: a tip matches when the SQL layer produced the rule it names, or when
 * every keyword it lists appears in the query. No embedding, no model - the same query gets the same advice,
 * which is what makes a skill testable.
 */

import type { Catalog } from '../../dataplane/src/sqlite.ts';
import { analyze, type Finding } from '../../sqllayer/src/analyze.ts';
import { analyzeSql } from '../../sqlkit-ts/src/index.ts';
import { SkillStore, type Tip } from './types.ts';

export interface Advice {
  tip: Tip;
  score: number;
  /** Why it matched, so a reviewer can disagree with the retrieval rather than with the tip. */
  why: string;
}

export interface AdviseOptions {
  dialect?: string;
  table?: string;
  domain?: string;
  limit?: number;
  /** Tips to leave out - the leave-one-out experiment, and a reviewer saying "not this time". */
  exclude?: string[];
  catalog?: Catalog;
  findings?: Finding[];
  /** The row count below which a full scan is not worth reporting; passed through to the SQL layer. */
  rowCountThreshold?: number;
}

export interface AdviceResult {
  findings: Finding[];
  advice: Advice[];
  /** Tips that matched the query's scope but not its shape, so "why not this tip" is answerable. */
  considered: { id: string; reason: string }[];
}

/** How much a finding's severity contributes to an advice entry's rank. */
const SEVERITY_WEIGHT: Record<string, number> = { high: 1, medium: 0.8, low: 0.5, info: 0.3 };

export function advise(store: SkillStore, sql: string, options: AdviseOptions = {}): AdviceResult {
  const findings = options.findings ?? analyze(sql, {
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.rowCountThreshold !== undefined ? { rowCountThreshold: options.rowCountThreshold } : {}),
  });
  const ruleIds = new Set(findings.map((finding) => finding.rule));
  const haystack = sql.toLowerCase();
  const exclude = new Set(options.exclude ?? []);
  const limit = options.limit ?? 3;

  // The tables the query actually reads. A tip scoped to a table is only offered when that table is in the
  // query - otherwise a lesson learned on one fact table leaks onto another that merely shares a rule.
  const queryTables = new Set(analyzeSql(sql).flatMap((statement) => statement.tables));

  const inScope = store.list({
    ...(options.dialect ? { dialect: options.dialect } : {}),
    ...(options.table ? { table: options.table } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
  }).filter((tip) => tip.status !== 'deprecated');

  const advice: Advice[] = [];
  const considered: { id: string; reason: string }[] = [];

  for (const tip of inScope) {
    if (exclude.has(tip.id)) {
      considered.push({ id: tip.id, reason: 'excluded for this request' });
      continue;
    }
    if (tip.scope.table && !queryTables.has(tip.scope.table)) {
      considered.push({ id: tip.id, reason: `the query does not read ${tip.scope.table}` });
      continue;
    }
    const ruleMatch = tip.applies.rule !== undefined && ruleIds.has(tip.applies.rule);
    const keywords = tip.applies.keywords ?? [];
    const keywordMatch = keywords.length > 0 && keywords.every((keyword) => haystack.includes(keyword.toLowerCase()));
    if (!ruleMatch && !keywordMatch) {
      if (tip.applies.rule) {
        considered.push({ id: tip.id, reason: `rule ${tip.applies.rule} did not fire on this query` });
      } else {
        considered.push({ id: tip.id, reason: `keywords [${keywords.join(', ')}] not all present` });
      }
      continue;
    }
    // Severity first: a high-severity finding (a cartesian product) outranks a low one (an unbounded result)
    // even when the low one's tip is older and better confirmed. Then the tip's own score.
    const severities = findings.filter((finding) => finding.rule === tip.applies.rule).map((finding) => finding.severity);
    const weight = severities.length > 0
      ? Math.max(...severities.map((severity) => SEVERITY_WEIGHT[severity] ?? 0.5))
      : keywordMatch ? 0.6 : 0.3;
    advice.push({
      tip,
      score: Math.round(weight * SkillStore.score(tip) * 1000) / 1000,
      why: ruleMatch ? `the SQL layer reported ${tip.applies.rule} (${severities.join('/')})` : `the query contains ${keywords.join(', ')}`,
    });
  }

  advice.sort((a, b) => b.score - a.score || (a.tip.id < b.tip.id ? -1 : 1));
  return { findings, advice: advice.slice(0, limit), considered };
}

/** The tips that count as "the injector's rule set" for a dialect: adopted and scoped to it. */
export function ruleSet(store: SkillStore, dialect: string): Tip[] {
  return store.list({ dialect }).filter((tip) => tip.status === 'adopted' && tip.applies.rule !== undefined);
}
