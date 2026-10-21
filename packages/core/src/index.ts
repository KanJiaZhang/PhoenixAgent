/**
 * M0 + M1 of PhoenixAgent, as a library: configuration, the base's HTTP surface, the model gateway, the
 * router and the logs. Nothing here knows what a semantic layer or an attribution is.
 */

export { loadConfig } from './config.ts';
export type { Config, LlmConfig } from './config.ts';
export { GraphClient, PhoenixGraphError } from './graph-client.ts';
export type { ToolCatalog, SchemaDraft, StoredSchema, WriteResult, GraphVertexProperty } from './graph-client.ts';
export { createGateway, NoneGateway, OpenAiGateway, LlmDisabled } from './llm.ts';
export type { LlmGateway, LlmRequest } from './llm.ts';
export { signatureOf, route, AMBIGUITY_MARGIN } from './router.ts';
export type { AgentName, QuerySignature, QuestionType, RouteDecision } from './router.ts';
export { AuditLog, appendJsonl, ensureDir, listFiles, readJson, readJsonl, writeJson } from './workspace.ts';
export type { AuditEntry } from './workspace.ts';
export { refusal, emptyCost } from './result.ts';
export type { AgentResult, AgentRefusal, AgentCost } from './result.ts';
