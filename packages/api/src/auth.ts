/**
 * Who is calling, and what may they do.
 *
 * Three roles, because that is how the three audiences in the plan actually differ:
 *
 * - **viewer** reads: reports, plans, the model, the skill library.
 * - **analyst** writes to the model and the SQL workspace: accepts a candidate, edits a statement, harvests a
 *   tip. Nothing they do is irreversible (the review log is append-only).
 * - **owner** does the two things that change what the business runs on: **publish** a model revision and
 *   **approve** a risk rule. Both are recorded with the actor's name.
 *
 * Keys come from the environment (`PAGENT_API_KEYS=key:role,key:role`). With no keys configured the server
 * generates one and prints it, so a demo is not accidentally open and a production deployment is not
 * accidentally locked.
 */

export type Role = 'viewer' | 'analyst' | 'owner';

const RANK: Record<Role, number> = { viewer: 1, analyst: 2, owner: 3 };

export interface Principal {
  actor: string;
  role: Role;
}

export interface AuthConfig {
  /** key -> { actor, role } */
  keys: Map<string, Principal>;
  /** True when the keys were generated because none were configured. */
  generated: boolean;
}

export function loadAuth(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const configured = (env.PAGENT_API_KEYS ?? '').split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  const keys = new Map<string, Principal>();
  for (const entry of configured) {
    const [key, role, actor] = entry.split(':');
    if (!key || !role) continue;
    if (!(role in RANK)) throw new Error(`PAGENT_API_KEYS entry '${entry}' has unknown role '${role}'`);
    keys.set(key, { actor: actor ?? role, role: role as Role });
  }
  if (keys.size > 0) return { keys, generated: false };
  const generatedKey = `dev-${Math.random().toString(36).slice(2, 10)}`;
  keys.set(generatedKey, { actor: 'dev', role: 'owner' });
  return { keys, generated: true };
}

export class Unauthorized extends Error {
  readonly status = 401;
  constructor(message = 'missing or unknown API key (send X-API-Key)') {
    super(message);
    this.name = 'Unauthorized';
  }
}

export class Forbidden extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'Forbidden';
  }
}

export function authenticate(auth: AuthConfig, header: string | undefined): Principal {
  const key = header?.trim();
  if (!key) throw new Unauthorized();
  const principal = auth.keys.get(key);
  if (!principal) throw new Unauthorized();
  return principal;
}

export function requireRole(principal: Principal, minimum: Role): void {
  if (RANK[principal.role] < RANK[minimum]) {
    throw new Forbidden(`${principal.actor} is ${principal.role}; this needs ${minimum}`);
  }
}
