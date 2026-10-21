/**
 * Re-prices a recorded plan so it can be harvested later.
 *
 * The ledger stores what a person did (the SQL at each step); it does not store the planner's output, because
 * that belongs to the database, not to the decision. So harvesting from a plan id means running the plan's
 * original and final SQL against the warehouse again - which is the honest order: the tip's evidence is a
 * measurement taken now, not a number copied out of a file that nobody can reproduce.
 */

import { DatabaseSync } from 'node:sqlite';
import { compareEvidence, explain } from '../../sqllayer/src/analyze.ts';
import type { PlanResult, PlanState } from '../../sqllayer/src/steps.ts';

export function analysePlanEvidence(state: PlanState, dbPath: string): PlanResult {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const before = explain(db, state.original);
    const lastRewrite = [...state.steps].reverse().find((step) => step.kind === 'rewrite');
    const after = lastRewrite ? explain(db, lastRewrite.sqlAfter) : undefined;
    return {
      id: state.id,
      original: state.original,
      createdAt: new Date().toISOString(),
      findings: state.findings,
      steps: state.steps,
      before,
      ...(after ? { after, comparison: compareEvidence(before, after) } : {}),
    };
  } finally {
    db.close();
  }
}
