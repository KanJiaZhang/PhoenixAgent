/**
 * The human-in-the-loop half of the semantic agent, as an append-only log.
 *
 * A review decision is a line, not an update. That is what makes three things true at once: the model can be
 * replayed to any point (so an answer can name the revision it was computed from), a rejected candidate stays
 * visible with the reason it was rejected (so "why is this metric missing" is answerable), and two people
 * cannot silently overwrite each other - the later line wins, and both are still there.
 *
 * `edit` implies acceptance. A reviewer who corrects a description has looked at the candidate and decided
 * it belongs in the model; forcing a second "accept" click would be a ritual, not a control.
 */

import { appendJsonl, readJsonl } from '../../core/src/workspace.ts';
import type { Candidate, Revision } from '../../contracts/src/index.ts';
import type { MergedCandidate } from './merge.ts';

export class ReviewLog {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  all(): Revision[] {
    return readJsonl<Revision>(this.path);
  }

  append(revision: Omit<Revision, 'revision'>): Revision {
    const next = { ...revision, revision: this.nextNumber() };
    appendJsonl(this.path, next);
    return next;
  }

  private nextNumber(): number {
    const all = this.all();
    return all.length === 0 ? 1 : Math.max(...all.map((revision) => revision.revision)) + 1;
  }
}

/** Applies the log to the merged candidates. Pure: same input, same output, so a replay is a check. */
export function applyRevisions(candidates: MergedCandidate[], revisions: Revision[]): MergedCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, structuredClone(candidate)]));

  for (const revision of [...revisions].sort((a, b) => a.revision - b.revision)) {
    const target = byId.get(revision.target);

    if (revision.action === 'add') {
      const added = revision.patch as unknown as MergedCandidate | undefined;
      if (added && typeof added.id === 'string') {
        byId.set(added.id, { ...added, observations: added.observations ?? [], conflictIds: [] });
      }
      continue;
    }

    if (!target) continue;

    switch (revision.action) {
      case 'accept':
        target.status = 'accepted';
        target.conflictIds = [];
        target.note = revision.reason;
        break;
      case 'reject':
        target.status = 'rejected';
        target.note = revision.reason;
        break;
      case 'edit':
        for (const [path, value] of Object.entries(revision.patch ?? {})) {
          setPath(target as unknown as Record<string, unknown>, path, value);
        }
        target.status = 'accepted';
        target.note = revision.reason;
        break;
      case 'resolve-conflict':
        target.status = 'accepted';
        target.conflictIds = [];
        target.note = `conflict resolved by ${revision.actor}: ${revision.reason}`;
        break;
      default:
        break;
    }
  }

  return [...byId.values()];
}

/** `payload.description` -> the nested key. Used by `edit` so the log can name one field. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next !== 'object' || next === null) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/** Open conflicts, grouped for the review screen: one row per decision a person has to make. */
export function openConflicts(candidates: MergedCandidate[]): MergedCandidate[] {
  return candidates.filter((candidate) => candidate.conflictIds.length > 0 || candidate.status === 'needs_review');
}

/** A human-added metric/relation, in the same shape the extractors emit, so nothing downstream special-cases it. */
export function humanCandidate(candidate: Omit<Candidate, 'provenance' | 'status' | 'confidence'> & {
  confidence?: number;
}): MergedCandidate {
  return {
    ...candidate,
    provenance: 'human',
    confidence: candidate.confidence ?? 1,
    status: 'accepted',
    observations: [{
      provenance: 'human',
      sourceFile: '(human)',
      expression: (candidate.payload as { expression?: string }).expression,
    }],
    conflictIds: [],
  };
}
