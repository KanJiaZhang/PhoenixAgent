/**
 * One timeline for "what changed, when, and who said yes".
 *
 * The repository already records every decision, but in five places: the review log (append-only JSONL), the API audit
 * trail (one line per request), the release event log, the learned lexicon, and the draft queue. Individually each is
 * honest; together they are the answer to the question an auditor actually asks. This module merges them without
 * inventing a second source of truth - it reads the files and sorts them.
 *
 * Two rules keep it from becoming a story instead of a record:
 *
 * - **Nothing is derived.** Every line is written by the component that made the decision; the timeline only orders
 *   them. A publish appears because `/v1/semantic/publish` was called (from the audit trail), not because a file
 *   exists.
 * - **Ties are broken deterministically.** Same timestamp, two systems: the order is fixed by kind, so two runs of the
 *   same history produce the same timeline byte for byte.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TimelineEvent {
  at: string;
  kind: 'review' | 'publish' | 'release' | 'lexicon' | 'draft';
  actor: string;
  detail: string;
  revision?: number;
  status?: number;
}

export interface Timeline {
  graph: string;
  events: TimelineEvent[];
  counts: Record<TimelineEvent['kind'], number>;
  /** Where each kind came from, so a reader can go and look. */
  sources: Record<TimelineEvent['kind'], string>;
  limits: string[];
}

const ORDER: Record<TimelineEvent['kind'], number> = { review: 0, publish: 1, release: 2, lexicon: 3, draft: 4 };

export function buildTimeline(options: { workspace: string; graph: string; auditPath?: string }): Timeline {
  const { workspace, graph } = options;
  const events: TimelineEvent[] = [];
  const auditPath = options.auditPath ?? join(workspace, 'audit', 'api.jsonl');

  for (const line of readJsonl(join(workspace, 'reviews', `${graph}.jsonl`))) {
    events.push({
      at: String(line.ts ?? ''),
      kind: 'review',
      actor: String(line.actor ?? 'unknown'),
      detail: `${String(line.action ?? '')} ${String(line.target ?? '')}${line.reason ? ` - ${String(line.reason)}` : ''}`,
    });
  }

  // a publish is a request that succeeded: the audit line is the evidence, not the presence of a snapshot file
  for (const line of readJsonl(auditPath)) {
    if (String(line.path ?? '') !== '/v1/semantic/publish') continue;
    if (Number(line.status) !== 200) continue;
    events.push({
      at: String(line.ts ?? ''), kind: 'publish', actor: String(line.actor ?? 'unknown'),
      detail: `${graph} published`, status: Number(line.status),
    });
  }

  for (const line of readJsonl(join(workspace, 'release', `${graph}.events.jsonl`))) {
    if (String(line.kind) === 'answer') continue; // one line per canary answer would drown the decisions
    events.push({
      at: String(line.ts ?? ''), kind: 'release', actor: String(line.actor ?? 'unknown'),
      detail: `${String(line.kind ?? '')} v${String(line.revision ?? '?')}${line.detail ? `: ${String(line.detail).slice(0, 160)}` : ''}`,
      ...(typeof line.revision === 'number' ? { revision: line.revision } : {}),
    });
  }

  for (const line of readJsonl(join(workspace, 'lexicon', `${graph}.jsonl`))) {
    events.push({
      at: String(line.at ?? ''), kind: 'lexicon', actor: String(line.model ?? 'unknown'),
      detail: `learned '${String(line.word ?? '')}' -> ${String(line.target ?? '')}${line.evidence ? ` (${String(line.evidence).slice(0, 80)})` : ''}`,
    });
  }

  const draftsPath = join(workspace, 'lexicon', `${graph}.drafts.json`);
  if (existsSync(draftsPath)) {
    for (const draft of JSON.parse(readFileSync(draftsPath, 'utf8')) as {
      id: string; word: string; target: string; status: string; proposedBy: string; at: string;
      reviewed?: { by: string; at: string; action: string; reason?: string };
    }[]) {
      events.push({
        at: draft.at, kind: 'draft', actor: draft.proposedBy,
        detail: `proposed '${draft.word}' -> ${draft.target}`,
      });
      if (draft.reviewed) {
        events.push({
          at: draft.reviewed.at, kind: 'draft', actor: draft.reviewed.by,
          detail: `${draft.reviewed.action} '${draft.word}'${draft.reviewed.reason ? `: ${draft.reviewed.reason}` : ''}`,
        });
      }
    }
  }

  events.sort((left, right) => {
    if (left.at !== right.at) return left.at.localeCompare(right.at);
    const kind = ORDER[left.kind] - ORDER[right.kind];
    if (kind !== 0) return kind;
    return left.detail.localeCompare(right.detail);
  });

  const counts = { review: 0, publish: 0, release: 0, lexicon: 0, draft: 0 };
  for (const event of events) counts[event.kind]++;

  return {
    graph,
    events,
    counts,
    sources: {
      review: join(workspace, 'reviews', `${graph}.jsonl`),
      publish: auditPath,
      release: join(workspace, 'release', `${graph}.events.jsonl`),
      lexicon: join(workspace, 'lexicon', `${graph}.jsonl`),
      draft: draftsPath,
    },
    limits: [
      '发布只以审计里的成功请求为准；手工改过模型文件的历史在这里看不出来',
      '时间线是"决定的时间"，不是"生效的时间"：灰度晋升后旧版本仍可能被 in-flight 请求使用',
      '吊销/回滚也是一条记录，不会从时间线里删掉之前的事件',
    ],
  };
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}
