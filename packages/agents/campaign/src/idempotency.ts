/**
 * Our own record of what we sent, because the platform's promise is not a fact we can check.
 *
 * The write-back payload carries an idempotency key and the docs say "the platform deduplicates on it". That is a
 * promise made by someone else. If the platform ignores the header, a retry after a timeout doubles the budget - and
 * the failure mode is money, not a stack trace. So this store keeps the keys we have actually committed, with the
 * receipt the platform returned, and `submitWriteback` consults it **before** calling the adapter.
 *
 * Three outcomes, and the difference between them matters:
 *
 * | the key was seen | what happens |
 * | --- | --- |
 * | committed | the stored receipt is returned, the adapter is not called (`replayed`) |
 * | rejected by the platform | the retry is allowed - a rejection is not a commitment |
 * | never seen | the adapter is called and the result recorded |
 *
 * The store is append-only JSONL: a crash between "platform accepted" and "we wrote it down" loses the record, which
 * is why the write happens *after* a successful commit and why a replay is cheap rather than clever.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WritebackPlan } from './writeback.ts';

export interface IdempotencyRecord {
  key: string;
  platform: string;
  /** `committed` is the only status that suppresses a retry. */
  status: 'committed' | 'rejected';
  /** What the platform said when it accepted the payload. */
  receiptId?: string;
  acceptedAt?: string;
  /** Hash of the payload body: two payloads with one key but different numbers would be a bug, not a replay. */
  payloadHash: string;
  at: string;
  actor: string;
  cells: number;
  proposedSpend: number;
}

export interface ReplayDecision {
  /** `replay` means the adapter must not be called. */
  decision: 'replay' | 'proceed';
  record?: IdempotencyRecord;
  /** Set when the key exists with a different payload: the caller should refuse, not guess. */
  conflict?: string;
}

export function payloadHashOf(payload: WritebackPlan): string {
  return createHash('sha256')
    .update(JSON.stringify({ platform: payload.platform, cells: payload.cells.map((cell) => [cell.cell, cell.proposedSpend]) }))
    .digest('hex')
    .slice(0, 32);
}

export class IdempotencyStore {
  readonly path: string;
  constructor(dir: string) {
    this.path = join(dir, 'writeback', 'idempotency.jsonl');
  }

  all(): IdempotencyRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as IdempotencyRecord);
  }

  /** The newest record for a key: a key can be rejected once and committed later. */
  find(key: string): IdempotencyRecord | undefined {
    return this.all().filter((record) => record.key === key).at(-1);
  }

  /**
   * Should this payload be sent at all?
   *
   * A committed key with the *same* payload is a replay. A committed key with a *different* payload is a collision
   * (or a bug in the key derivation) and must be refused: sending it would either double the budget or quietly
   * replace a plan someone already approved.
   */
  check(payload: WritebackPlan): ReplayDecision {
    const record = this.find(payload.idempotencyKey);
    if (!record) return { decision: 'proceed' };
    if (record.status !== 'committed') return { decision: 'proceed' };
    const payloadHash = payloadHashOf(payload);
    if (record.payloadHash !== payloadHash) {
      return {
        decision: 'proceed',
        conflict: `key ${record.key} was committed with a different payload (${record.payloadHash} vs ${payloadHash})`,
      };
    }
    return { decision: 'replay', record };
  }

  record(entry: Omit<IdempotencyRecord, 'payloadHash'> & { payloadHash?: string }): IdempotencyRecord {
    const complete: IdempotencyRecord = {
      ...entry,
      payloadHash: entry.payloadHash ?? '',
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(complete)}\n`, 'utf8');
    return complete;
  }
}
