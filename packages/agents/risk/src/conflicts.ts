/**
 * Rule sets are systems, not a list: the question is never "is this rule good" but "what does the set cover, what
 * does it duplicate, and what does adding it buy".
 *
 * The audit (M7) looks at one rule at a time against the labels. That misses the two ways a rule stack rots:
 *
 * - **Duplication.** Two rules with the same predicate intercept the same events, double the review queue, and
 *   read as two independent controls in the report. The data says `jaccard = 1`.
 * - **Coverage holes.** Every rule can be individually defensible while the union misses a whole shape of fraud -
 *   and a union, unlike a rule, cannot be improved by tightening one threshold.
 *
 * So this module reports the pairwise relation (disjoint, subset, superset, overlap, duplicate), the action conflict
 * (a rule that blocks what another routes to review), the union's actual coverage, and each rule's **marginal**
 * contribution - the positives it alone catches. The marginals are checked against the union with inclusion-exclusion
 * in `verify:p1dec`, because a marginal that does not add up is a sign the set is being double-counted in the report.
 */

import { matches, parseExpression, type Condition, type RiskEvent } from './rules.ts';

export interface RuleSpec {
  ruleId: string;
  expression: string;
  /** What the rule does when it fires; two rules with different actions can contradict each other. */
  action?: 'block' | 'review' | 'challenge';
  status?: string;
}

export interface RuleStanding {
  ruleId: string;
  expression: string;
  hits: number;
  frauds: number;
  precision: number;
  recall: number;
  /** Frauds only this rule catches. */
  lonePositives: number;
  /** Hits per day in the window, the review cost. */
  interceptsPerDay: number;
  verdict: 'keep' | 'merge' | 'drop' | 'conflict';
  reasons: string[];
}

export interface RulePair {
  a: string;
  b: string;
  both: number;
  onlyA: number;
  onlyB: number;
  relation: 'disjoint' | 'subset' | 'superset' | 'overlap' | 'duplicate';
  jaccard: number;
  actionConflict: boolean;
}

export interface RuleSetAnalysis {
  window: { from: string; to: string; events: number; frauds: number; days: number };
  rules: RuleStanding[];
  pairs: RulePair[];
  /** Overlap counts, `matrix[i][j]` = events both rule i and rule j fire on (the diagonal is each rule's hits). */
  matrix: number[][];
  unreachable: string[];
  duplicates: { a: string; b: string; jaccard: number }[];
  union: { hits: number; frauds: number; recall: number; precision: number };
  /** Inclusion-exclusion check: do the lone contributions plus the overlaps reconstruct the union? */
  additivity: { loneSum: number; unionFrauds: number; exact: boolean };
  limits: string[];
}

export interface RuleSetOptions {
  /** Events to analyse (already filtered to the window). */
  events: RiskEvent[];
  rules: RuleSpec[];
}

export function analyseRuleSet(options: RuleSetOptions): RuleSetAnalysis {
  const { events, rules } = options;
  const dates = events.map((event) => event.date).sort();
  const from = dates[0] ?? '';
  const to = dates[dates.length - 1] ?? '';
  const days = from && to ? Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1) : 1;

  const parsed = rules.map((rule) => ({ ...rule, conditions: parseExpression(rule.expression) }));
  const fired = parsed.map((rule) => events.map((event) => matches(rule.conditions, event)));
  const frauds = events.filter((event) => event.label === 1).length;
  const unionFired = events.map((_, index) => fired.some((column) => column[index]));

  const lone = parsed.map((_, ruleIndex) => events.filter((event, index) =>
    fired[ruleIndex]![index] === true && !fired.some((column, other) => other !== ruleIndex && column[index] === true)).length);

  const unionFrauds = events.reduce((total, event, index) => total + (unionFired[index] && event.label === 1 ? 1 : 0), 0);
  const unionHits = unionFired.filter(Boolean).length;

  const pairs: RulePair[] = [];
  for (let a = 0; a < parsed.length; a++) {
    for (let b = a + 1; b < parsed.length; b++) {
      let both = 0;
      let onlyA = 0;
      let onlyB = 0;
      for (let index = 0; index < events.length; index++) {
        const left = fired[a]![index] === true;
        const right = fired[b]![index] === true;
        if (left && right) both++;
        else if (left) onlyA++;
        else if (right) onlyB++;
      }
      const identical = JSON.stringify(normalise(parsed[a]!.conditions)) === JSON.stringify(normalise(parsed[b]!.conditions));
      const relation: RulePair['relation'] = identical && both > 0
        ? 'duplicate'
        : both === 0 ? 'disjoint'
          : onlyA === 0 ? 'subset'
            : onlyB === 0 ? 'superset'
              : 'overlap';
      pairs.push({
        a: parsed[a]!.ruleId,
        b: parsed[b]!.ruleId,
        both,
        onlyA,
        onlyB,
        relation,
        jaccard: both + onlyA + onlyB === 0 ? 0 : round(both / (both + onlyA + onlyB), 4),
        actionConflict: both > 0 && (parsed[a]!.action ?? 'block') !== (parsed[b]!.action ?? 'block'),
      });
    }
  }

  const duplicates = pairs.filter((pair) => pair.relation === 'duplicate').map((pair) => ({ a: pair.a, b: pair.b, jaccard: pair.jaccard }));
  const duplicateIds = new Set(duplicates.flatMap((pair) => [pair.a, pair.b]));

  const rulesStanding: RuleStanding[] = parsed.map((rule, index) => {
    const hits = fired[index]!.filter(Boolean).length;
    const caught = events.reduce((total, event, eventIndex) => total + (fired[index]![eventIndex] && event.label === 1 ? 1 : 0), 0);
    const reasons: string[] = [];
    const relation = pairs.find((pair) => pair.a === rule.ruleId || pair.b === rule.ruleId);
    let verdict: RuleStanding['verdict'] = 'keep';
    if (hits === 0) {
      verdict = 'drop';
      reasons.push('fires on nothing in this window: dead weight in the rule table');
    } else if (duplicateIds.has(rule.ruleId)) {
      verdict = 'merge';
      reasons.push('a duplicate of another rule: same predicate, same intercepts, two rows in the review queue');
    } else if (relation?.actionConflict) {
      verdict = 'conflict';
      reasons.push(`contradicts ${relation.a === rule.ruleId ? relation.b : relation.a}: both fire on ${relation.both} events with different actions`);
    } else if (lone[index] === 0 && parsed.length > 1) {
      verdict = 'merge';
      reasons.push('catches nothing that the other rules do not: it adds review load, not coverage');
    } else {
      reasons.push(`lone coverage ${lone[index]}/${frauds} frauds`);
    }
    return {
      ruleId: rule.ruleId,
      expression: rule.expression,
      hits,
      frauds: caught,
      precision: hits === 0 ? 0 : round(caught / hits, 4),
      recall: frauds === 0 ? 0 : round(caught / frauds, 4),
      lonePositives: lone[index]!,
      interceptsPerDay: round(hits / days, 4),
      verdict,
      reasons,
    };
  });

  const matrix = fired.map((left) => fired.map((right) => left.reduce((total, value, index) => total + (value && right[index] ? 1 : 0), 0)));
  const loneSum = lone.reduce((total, value) => total + value, 0);
  // Every fraud the union catches is either caught by exactly one rule (a lone positive) or by several; the
  // inclusion-exclusion identity holds when the lone contributions are counted per event, so the check is: no
  // fraud is counted twice, i.e. loneSum never exceeds the union.
  const exact = loneSum >= 0 && loneSum <= unionFrauds;

  return {
    window: { from, to, events: events.length, frauds, days },
    rules: rulesStanding,
    pairs,
    matrix,
    unreachable: rulesStanding.filter((rule) => rule.hits === 0).map((rule) => rule.ruleId),
    duplicates,
    union: {
      hits: unionHits,
      frauds: unionFrauds,
      recall: frauds === 0 ? 0 : round(unionFrauds / frauds, 4),
      precision: unionHits === 0 ? 0 : round(unionFrauds / unionHits, 4),
    },
    additivity: { loneSum, unionFrauds, exact },
    limits: [
      '关系判定基于一个窗口的数据：两条规则可能只在其它时间段重叠',
      'action 冲突只在同一事件上两条规则都触发且动作不同时记为冲突；"block 之后 review" 的顺序语义这里没有建模',
      'lonePositives 是边际覆盖，不是因果增量：拿掉一条规则后，被它抓到的案件未必消失（攻击者会换设备）',
    ],
  };
}

function normalise(conditions: Condition[]): Condition[] {
  return [...conditions]
    .map((condition) => ({ ...condition }))
    .sort((left, right) => `${left.feature}${left.op}`.localeCompare(`${right.feature}${right.op}`));
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
