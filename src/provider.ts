/**
 * Provider factory — selects the LLM adapter based on environment variables.
 *
 * Supported providers:
 *   - anthropic (default): Native Anthropic API via LoggingAnthropicAdapter.
 *       Requires ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN for OAuth).
 *       Optional ANTHROPIC_BASE_URL to point at a compatible endpoint.
 *
 *   - openai-compatible: OpenAI Chat Completions API via OpenAICompatibleAdapter
 *       wrapped in LoggingProviderAdapter.
 *       Requires OPENAI_BASE_URL (e.g. https://api.literouter.com/v1).
 *       Optional OPENAI_API_KEY (some local servers need no key).
 *
 * Env vars:
 *   LLM_PROVIDER       - 'anthropic' | 'openai-compatible' (default: anthropic)
 *   ANTHROPIC_API_KEY  - Anthropic API key (anthropic provider)
 *   ANTHROPIC_AUTH_TOKEN - OAuth bearer token (anthropic provider, takes precedence)
 *   ANTHROPIC_BASE_URL - Override Anthropic API base URL
 *   OPENAI_API_KEY     - API key for OpenAI-compatible endpoint
 *   OPENAI_BASE_URL    - Base URL for OpenAI-compatible endpoint (required for openai-compatible)
 *   MODEL              - Override model (handled by caller, not here)
 */

import type { ProviderAdapter } from '@animalabs/membrane';
import { OpenAICompatibleAdapter } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from './logging-adapter.js';
import { LoggingProviderAdapter } from './logging-provider-adapter.js';
import type { ReasoningGetter } from './logging-adapter.js';

export type ProviderType = 'anthropic' | 'openai-compatible';

export function getProviderType(): ProviderType {
  const provider = process.env.LLM_PROVIDER ?? 'anthropic';
  if (provider !== 'anthropic' && provider !== 'openai-compatible') {
    throw new Error(
      `Unsupported LLM_PROVIDER=${provider}. Expected "anthropic" or "openai-compatible".`,
    );
  }
  return provider;
}

/**
 * Create the LLM provider adapter based on environment variables.
 *
 * @param logPath - Path to the JSONL log file for request/response logging.
 * @param getReasoning - Optional callback returning the current reasoning settings.
 * @returns A ProviderAdapter instance ready for use with Membrane.
 */
export function createAdapter(
  logPath: string,
  getReasoning?: ReasoningGetter,
): ProviderAdapter {
  const provider = getProviderType();

  switch (provider) {
    case 'openai-compatible': {
      const baseURL = process.env.OPENAI_BASE_URL;
      if (!baseURL) {
        throw new Error(
          'LLM_PROVIDER=openai-compatible requires OPENAI_BASE_URL to be set. ' +
          'Set it in .env or environment (e.g. OPENAI_BASE_URL=https://api.literouter.com/v1).',
        );
      }
      const apiKey = process.env.OPENAI_API_KEY || undefined;
      const inner = new OpenAICompatibleAdapter({
        baseURL,
        apiKey,
      });
      return new LoggingProviderAdapter(
        inner,
        logPath,
        getReasoning,
      );
    }

    case 'anthropic': {
      const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
      const apiKey = process.env.ANTHROPIC_API_KEY;

      if (!apiKey && !authToken) {
        throw new Error(
          'Missing ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN). Set one in .env or environment. ' +
          'Alternatively, set LLM_PROVIDER=openai-compatible with OPENAI_BASE_URL to use an OpenAI-compatible endpoint.',
        );
      }

      return new LoggingAnthropicAdapter(
        {
          ...(authToken
            ? {
                authToken,
                defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
              }
            : { apiKey: apiKey! }),
          baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
        },
        logPath,
        getReasoning,
      );
    }
  }
}

/**
 * Whether the current provider supports Anthropic-native features
 * (thinking/reasoning blocks, count_tokens endpoint).
 */
export function isAnthropicProvider(): boolean {
  return getProviderType() === 'anthropic';
}
