import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import { LoggingProviderAdapter } from '../src/logging-provider-wrapper.js';

// (local patch) The dedicated compression membrane shares the primary's
// provider name and llm-calls log; its records carry `tag: 'compression'` so
// the two stay tell-apart-able. Untagged wrappers write records unchanged.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'logging-provider-tag-'));
  dirs.push(dir);
  return join(dir, 'llm-calls.jsonl');
}

const response = { content: [{ type: 'text', text: 'zz-ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} } as unknown as ProviderResponse;

function adapter(fail?: Error): ProviderAdapter {
  return {
    name: 'openai-compatible',
    usageCacheConvention: 'unknown',
    requiresNativeResponsesInput: false,
    supportsModel: () => true,
    complete: async () => { if (fail) throw fail; return response; },
    stream: async () => { if (fail) throw fail; return response; },
  } as ProviderAdapter;
}

const request = { model: 'zz-model', maxTokens: 16, messages: [{ role: 'user', content: 'zz-prompt' }] } as unknown as ProviderRequest;

function records(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('LoggingProviderAdapter purpose tag', () => {
  test('a tagged wrapper stamps every call and error record', async () => {
    const path = logFile();
    await new LoggingProviderAdapter(adapter(), path, undefined, { tag: 'compression' }).complete(request);
    await expect(
      new LoggingProviderAdapter(adapter(new Error('zz down')), path, undefined, { tag: 'compression' }).stream(request, {} as never),
    ).rejects.toThrow('zz down');
    const [call, error] = records(path);
    expect(call).toMatchObject({ type: 'call', provider: 'openai-compatible', tag: 'compression', kind: 'complete' });
    expect(error).toMatchObject({ type: 'error', provider: 'openai-compatible', tag: 'compression', kind: 'stream' });
  });

  test('an untagged wrapper writes no tag key', async () => {
    const path = logFile();
    await new LoggingProviderAdapter(adapter(), path).complete(request);
    const [call] = records(path);
    expect('tag' in call!).toBe(false);
  });
});

describe('LoggingProviderAdapter defaultExtra', () => {
  function capturing(): { adapter: ProviderAdapter; seen: ProviderRequest[] } {
    const seen: ProviderRequest[] = [];
    const a = adapter();
    return {
      seen,
      adapter: {
        ...a,
        complete: async (r: ProviderRequest) => { seen.push(r); return response; },
        stream: async (r: ProviderRequest) => { seen.push(r); return response; },
      } as ProviderAdapter,
    };
  }

  test('adds default extra params to every call; request values win', async () => {
    const { adapter: inner, seen } = capturing();
    const w = new LoggingProviderAdapter(inner, logFile(), undefined, { tag: 'compression', defaultExtra: { prompt_cache_key: 'zz:compression' } });
    await w.complete(request);
    await w.stream({ ...request, extra: { prompt_cache_key: 'zz:own', other: 1 } } as ProviderRequest, {} as never);
    expect(seen[0]!.extra).toEqual({ prompt_cache_key: 'zz:compression' });
    expect(seen[1]!.extra).toEqual({ prompt_cache_key: 'zz:own', other: 1 });
  });

  test('without defaultExtra the request passes through untouched', async () => {
    const { adapter: inner, seen } = capturing();
    await new LoggingProviderAdapter(inner, logFile()).complete(request);
    expect(seen[0]!.extra).toBeUndefined();
  });
});
