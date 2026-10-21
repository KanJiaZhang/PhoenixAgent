/**
 * M8: the HTTP surface. Roles, a confirm gate, an audit line per call, and a console over the same endpoints.
 */

export { createAgentServer, HttpError } from './server.ts';
export type { ServerOptions, AgentServer } from './server.ts';
export { loadAuth, authenticate, requireRole, Unauthorized, Forbidden } from './auth.ts';
export type { AuthConfig, Principal, Role } from './auth.ts';
export { ConfirmTokens, ConfirmationRejected } from './confirm.ts';
export type { ConfirmationClaims } from './confirm.ts';
