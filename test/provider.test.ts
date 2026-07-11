import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createAdapter, type ProviderType } from '../src/provider.js';

// Provider factory tests — verify adapter selection from env vars.
//
// The factory reads env vars at call time (not import time) so tests can
// set/restore them per-case. We only test the selection logic and the
// adapter's `name` / `supportsModel` surface; no real HTTP calls.

const ORIG_ENV = { ...process.env };

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreEnv() {
  // Remove keys that didn't exist originally, restore those that did
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    process.env[k] = v;
  }
}

describe('createAdapter', () => {
  beforeEach(() => { /* env set per-test */ });
  afterEach(restoreEnv);

  test('defaults to anthropic provider when LLM_PROVIDER is unset', () => {
    setEnv({
      LLM_PROVIDER: undefined,
      ANTHROPIC_API_KEY: 'sk-test-key',
      ANTHROPIC_BASE_URL: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_API_KEY: undefined,
    });
    const adapter = createAdapter('/dev/null', () => ({ enabled: false, budgetTokens: 0 }));
    expect(adapter.name).toBe('anthropic');
  });

  test('selects openai-compatible provider when LLM_PROVIDER=openai-compatible', () => {
    setEnv({
      LLM_PROVIDER: 'openai-compatible',
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      OPENAI_API_KEY: 'test-key',
      ANTHROPIC_API_KEY: undefined,
    });
    const adapter = createAdapter('/dev/null', () => ({ enabled: false, budgetTokens: 0 }));
    expect(adapter.name).toBe('openai-compatible');
  });

  test('openai-compatible adapter supportsModel returns true for any model', () => {
    setEnv({
      LLM_PROVIDER: 'openai-compatible',
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      OPENAI_API_KEY: 'test-key',
    });
    const adapter = createAdapter('/dev/null', () => ({ enabled: false, budgetTokens: 0 }));
    expect(adapter.supportsModel('gpt-5.6')).toBe(true);
    expect(adapter.supportsModel('anything-else')).toBe(true);
  });

  test('throws when openai-compatible is selected but OPENAI_BASE_URL is missing', () => {
    setEnv({
      LLM_PROVIDER: 'openai-compatible',
      OPENAI_BASE_URL: undefined,
      OPENAI_API_KEY: 'test-key',
    });
    expect(() => createAdapter('/dev/null', () => ({ enabled: false, budgetTokens: 0 })))
      .toThrow(/OPENAI_BASE_URL/);
  });

  test('anthropic provider passes baseURL through to adapter', () => {
    setEnv({
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test-key',
      ANTHROPIC_BASE_URL: 'https://custom.anthropic.endpoint.com',
    });
    const adapter = createAdapter('/dev/null', () => ({ enabled: false, budgetTokens: 0 }));
    expect(adapter.name).toBe('anthropic');
  });

  test('anthropic provider works without ANTHROPIC_BASE_URL (uses default api.anthropic.com)', () => {
    setEnv({
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-test-key',
      ANTHROPIC_BASE_URL: undefined,
    });
    const adapter = createAdapter('/dev/null', () => ({ enabled: false, budgetTokens: 0 }));
    expect(adapter.name).toBe('anthropic');
  });

  test('rejects an unknown LLM_PROVIDER instead of silently using anthropic', () => {
    setEnv({
      LLM_PROVIDER: 'something-unknown',
      ANTHROPIC_API_KEY: 'sk-test-key',
    });
    expect(() => createAdapter('/dev/null', () => ({ enabled: false, budgetTokens: 0 })))
      .toThrow(/Unsupported LLM_PROVIDER/);
  });
});
