#!/usr/bin/env node
/**
 * `risk` on the command line: report the trend and the rules, then approve (or reject) one by id.
 *
 * Approval lives here rather than inside the agent because it is a human act: the CLI writes the log line with
 * the actor's name, and the agent only ever reads that log.
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { loadConfig } from '../../../core/src/config.ts';
import { sqliteRunner } from '../../../dataplane/src/sqlite.ts';
import { assertReadOnly } from '../../../dataplane/src/guard.ts';
import { SkillStore } from '../../../skills/src/types.ts';
import { harvestFromRisk } from '../../../skills/src/harvest.ts';
import { RiskApprovals, riskAgent } from './agent.ts';

const argv = process.argv.slice(2);
const command = argv[0]?.startsWith('--') ? 'report' : (argv[0] ?? 'report');
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const json = argv.includes('--json');

const config = loadConfig();
const fixtures = flag('fixtures') ?? config.fixtures;
const workspace = flag('workspace') ?? config.workspace;
const graph = flag('graph') ?? 'demo-analytics';
const actor = flag('actor') ?? process.env.PAGENT_ACTOR ?? 'risk-lead';
const approvals = new RiskApprovals(workspace, graph);

if (command === 'approve' || command === 'reject') {
  const ruleId = flag('rule');
  const expression = flag('expression') ?? '';
  if (!ruleId) {
    console.error(`${command} needs --rule <id> (and --expression "...")`);
    process.exit(2);
  }
  const entry = approvals.decide(ruleId, expression, command === 'approve' ? 'approve' : 'reject',
    actor, flag('note') ?? `${command} from the command line`);
  console.log(JSON.stringify(entry, null, 2));
  process.exit(0);
}

if (command === 'list') {
  console.log(JSON.stringify(approvals.all(), null, 2));
  process.exit(0);
}

const dbPath = join(fixtures, 'data', 'demo.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const runner = sqliteRunner(db, { rowLimit: 200_000, timeoutMs: 30_000 });
  const run = (sql: string) => {
    assertReadOnly(sql);
    return runner(sql);
  };
  const result = riskAgent({
    run,
    graph,
    workspace,
    ...(flag('holdout-months') ? { holdoutMonths: Number(flag('holdout-months')) } : {}),
    ...(flag('min-precision') ? { minPrecision: Number(flag('min-precision')) } : {}),
    ...(flag('min-recall') ? { minRecall: Number(flag('min-recall')) } : {}),
  });

  let harvested: { id: string; status: string }[] = [];
  if (argv.includes('--harvest')) {
    const store = new SkillStore(join(workspace, 'skills'));
    harvested = harvestFromRisk(store, result, { actor }).map((tip) => ({ id: tip.id, status: tip.status }));
  }

  if (json) {
    console.log(JSON.stringify({ ...result, harvested }, null, 2));
  } else {
    console.log(result.explanation);
    console.log('');
    console.log(`queries: ${result.cost.queries} · events: ${result.cost.events} · features: ${result.cost.features} · ${result.cost.ms}ms`);
    for (const warning of result.confidence.warnings) console.log(`warning: ${warning}`);
    for (const refusal of result.refusals) console.log(`refusal: ${refusal.message}`);
    for (const tip of harvested) console.log(`skill: ${tip.status} ${tip.id}`);
    if (result.rules.length > 0) {
      console.log('');
      console.log('rules:');
      for (const rule of result.rules.slice(0, 6)) {
        const metrics = rule.holdout ?? rule.train;
        console.log(`  ${rule.status.padEnd(9)} ${rule.id.padEnd(9)} ${rule.expression}  `
          + `P=${metrics.precision} R=${metrics.recall} cov=${metrics.coverage}`);
      }
    }
  }
} finally {
  db.close();
}
