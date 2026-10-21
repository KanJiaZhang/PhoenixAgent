/**
 * The model, behind a switch that defaults to off.
 *
 * The gateway is small on purpose: one method, text in, text out, and a JSON variant that refuses to
 * invent structure. What it must never become is a second source of truth. Callers pass its output through
 * the same validation as any other candidate - `provenance: 'llm'`, confidence below a parser's, and no
 * path to `accepted` that skips a probe or a person.
 *
 * `NoneGateway` is not an error path. It is the enterprise default: with `PAGENT_LLM=none` the deterministic
 * document reader still runs, the DDL and ETL readers are unaffected, and the gate is identical.
 */

import type { Config, LlmConfig } from './config.ts';

export class LlmDisabled extends Error {
  constructor() {
    super('the LLM gateway is disabled (PAGENT_LLM=none); this call should have been guarded by gateway.enabled');
    this.name = 'LlmDisabled';
  }
}

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmGateway {
  readonly enabled: boolean;
  readonly model: string;
  complete(request: LlmRequest): Promise<string>;
  /** Asks for JSON and returns null when the answer is not JSON - never a guessed object. */
  completeJson<T>(request: LlmRequest): Promise<T | null>;
}

export class NoneGateway implements LlmGateway {
  readonly enabled = false;
  readonly model = 'none';

  async complete(): Promise<string> {
    throw new LlmDisabled();
  }

  async completeJson<T>(): Promise<T | null> {
    throw new LlmDisabled();
  }
}

export class OpenAiGateway implements LlmGateway {
  readonly enabled = true;
  readonly model: string;
  private readonly config: LlmConfig;

  constructor(config: LlmConfig) {
    this.config = config;
    this.model = config.model;
  }

  async complete(request: LlmRequest): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.config.model,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens ?? 2000,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`LLM answered ${response.status}: ${(await response.text()).slice(0, 400)}`);
      }
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      return body.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  async completeJson<T>(request: LlmRequest): Promise<T | null> {
    const text = await this.complete({
      ...request,
      system: `${request.system}\n\nAnswer with JSON only. No prose, no markdown fence.`,
    });
    const start = text.search(/[[{]/);
    if (start < 0) return null;
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

export function createGateway(config: Config['llm']): LlmGateway {
  if (config.provider === 'none') return new NoneGateway();
  if (!config.apiKey) {
    throw new Error('PAGENT_LLM=openai needs PAGENT_LLM_API_KEY');
  }
  return new OpenAiGateway(config);
}
