/**
 * The confirmation gate: a plan a client has to *look at* before it runs.
 *
 * The base does this with a signed token rather than a server session, and the reason holds here: no
 * conversation state, so a restart or a second replica does not lose a pending confirmation. The token covers
 * a hash of the plan and an expiry, signed with HMAC.
 *
 * Two properties this file has to keep:
 *
 * - **The plan is what was confirmed.** The hash is over the serialised plan, not over the question, so a
 *   client cannot confirm a cheap plan and then send a different, expensive one with the same token.
 * - **A tampered token is a refusal, not a retry.** Signature mismatch and expiry are different errors with
 *   different hints - "you changed the plan" is not "you were too slow".
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface ConfirmationClaims {
  planHash: string;
  expiresAt: number;
  /** Which endpoint the token was issued for, so a token cannot be replayed on another one. */
  scope: string;
}

export class ConfirmationRejected extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'ConfirmationRejected';
  }
}

export class ConfirmTokens {
  private readonly secret: Buffer;
  private readonly ttlMs: number;

  constructor(secret: string, ttlMs = 5 * 60_000) {
    this.secret = Buffer.from(secret, 'utf8');
    this.ttlMs = ttlMs;
  }

  static planHash(plan: unknown): string {
    return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 32);
  }

  issue(plan: unknown, scope: string, now = Date.now()): { token: string; expiresAt: string; planHash: string } {
    const planHash = ConfirmTokens.planHash(plan);
    const expiresAt = now + this.ttlMs;
    const payload = `${scope}.${planHash}.${expiresAt}`;
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return {
      token: `${payload}.${signature}`,
      expiresAt: new Date(expiresAt).toISOString(),
      planHash,
    };
  }

  /** Verifies that the token was issued for this plan and this endpoint, and that it has not expired. */
  verify(token: string, plan: unknown, scope: string, now = Date.now()): ConfirmationClaims {
    const parts = token.split('.');
    if (parts.length !== 4) throw new ConfirmationRejected('the confirmation token is malformed', 'token-malformed');
    const [tokenScope, planHash, expiresRaw, signature] = parts as [string, string, string, string];
    const payload = `${tokenScope}.${planHash}.${expiresRaw}`;
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ConfirmationRejected('the confirmation token was not issued by this service', 'token-invalid', 403);
    }
    if (tokenScope !== scope) {
      throw new ConfirmationRejected(`this token was issued for '${tokenScope}', not '${scope}'`, 'token-scope');
    }
    const expiresAt = Number(expiresRaw);
    if (!Number.isFinite(expiresAt) || now > expiresAt) {
      throw new ConfirmationRejected('the confirmation token has expired; plan it again', 'token-expired', 410);
    }
    if (ConfirmTokens.planHash(plan) !== planHash) {
      throw new ConfirmationRejected('the plan changed since it was confirmed; plan it again', 'plan-mismatch');
    }
    return { planHash, expiresAt, scope: tokenScope };
  }
}
