/**
 * What every sub-agent returns, so a client can treat them the same way.
 *
 * The shape is the base's (`answer`, `plan`, `provenance`, `confidence`, `limits`) plus the two things a
 * data product owes its reader: `refusals` - why it would not answer, with what was missing - and `cost` -
 * how many queries it took. A refusal is a first-class answer here, not an empty result.
 */

export interface AgentRefusal {
  code:
    | 'no-such-metric'
    | 'no-such-dimension'
    | 'ambiguous'
    | 'not-in-model'
    | 'unvalidated'
    | 'out-of-scope'
    | 'budget';
  message: string;
  /** What would make it answerable, stated as an action: "add the metric", "pick one of these". */
  hint?: string;
  candidates?: string[];
}

export interface AgentCost {
  queries: number;
  rows: number;
  ms: number;
  tokens?: number;
}

export interface AgentResult<TAnswer = unknown> {
  agent: string;
  answer?: TAnswer;
  plan?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  confidence: { score: number; warnings: string[] };
  limits: string[];
  refusals: AgentRefusal[];
  cost: AgentCost;
}

export function refusal(code: AgentRefusal['code'], message: string, hint?: string, candidates?: string[]): AgentRefusal {
  return { code, message, hint, candidates };
}

export function emptyCost(): AgentCost {
  return { queries: 0, rows: 0, ms: 0 };
}
