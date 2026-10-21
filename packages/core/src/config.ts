/**
 * Configuration, and one decision about it: everything has a working default.
 *
 * `PAGENT_LLM=none` is the default, and that is not a placeholder - it is the mode the product has to be
 * good in, because an enterprise deployment starts with "no model leaves this network", and often stays
 * there. The LLM is an optional reader of documents and narrator of results; the routing, the probes, the
 * gate and the SQL never need it.
 */

export interface LlmConfig {
  provider: 'none' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface Config {
  phoenix: { baseUrl: string; apiKey: string; timeoutMs: number };
  llm: LlmConfig;
  /** Where build artifacts, revisions and audit lines live. */
  workspace: string;
  /** Where the demo fixtures live. */
  fixtures: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    phoenix: {
      baseUrl: (env.PHOENIXGRAPH_API ?? 'http://localhost:8081').replace(/\/$/, ''),
      apiKey: env.PHOENIXGRAPH_API_KEY ?? '',
      timeoutMs: Number(env.PHOENIXGRAPH_TIMEOUT_MS ?? 20_000),
    },
    llm: {
      provider: env.PAGENT_LLM === 'openai' ? 'openai' : 'none',
      baseUrl: (env.PAGENT_LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey: env.PAGENT_LLM_API_KEY ?? '',
      model: env.PAGENT_LLM_MODEL ?? 'gpt-4o-mini',
      timeoutMs: Number(env.PAGENT_LLM_TIMEOUT_MS ?? 60_000),
    },
    workspace: env.PAGENT_WORKSPACE ?? '.pag',
    fixtures: env.PAGENT_FIXTURES ?? 'fixtures/demo',
  };
}
