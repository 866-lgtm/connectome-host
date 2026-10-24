import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCompressionMembrane, NoRetryMembrane } from '../src/compression-membrane.js';

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;
const received: Array<Record<string, unknown>> = [];
let status = 200;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      received.push((await req.json()) as Record<string, unknown>);
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { message: 'zz failure', type: 'server_error' } }), { status });
      }
      return Response.json({
        id: 'chatcmpl-zz', object: 'chat.completion', model: 'zz-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'zz-summary' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    },
  });
  baseURL = `http://127.0.0.1:${server.port}/v1`;
});
afterAll(() => server.stop(true));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); received.length = 0; status = 200; });

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'compression-membrane-'));
  dirs.push(dir);
  const llmLogPath = join(dir, 'llm-calls.jsonl');
  const membrane = buildCompressionMembrane({
    baseURL, apiKey: 'zz', assistantParticipant: 'zz-agent', llmLogPath, promptCacheKey: 'zz-key:compression',
  });
  return { membrane, llmLogPath };
}

const request = {
  messages: [{ participant: 'user', content: [{ type: 'text' as const, text: 'zz-history' }] }],
  config: { model: 'zz-model', maxTokens: 64 },
};

describe('compression membrane', () => {
  test('a call reaches the endpoint with the cache key and is logged tagged compression', async () => {
    const { membrane, llmLogPath } = build();
    expect(membrane).toBeInstanceOf(NoRetryMembrane);
    const response = await membrane.complete(request as never);
    expect(response.content.some((b) => b.type === 'text')).toBe(true);
    expect(received.length).toBe(1);
    expect(received[0]!.prompt_cache_key).toBe('zz-key:compression');
    const record = JSON.parse(readFileSync(llmLogPath, 'utf-8').trim().split('\n')[0]!);
    expect(record.tag).toBe('compression');
  });

  test('a retryable failure is sent once and handed back (retry: false)', async () => {
    const { membrane } = build();
    status = 503;
    await expect(membrane.complete(request as never)).rejects.toBeDefined();
    expect(received.length).toBe(1);
  });

  test('a 429 is not retried by membrane either (its floor is off with retry: false)', async () => {
    const { membrane } = build();
    status = 429;
    await expect(membrane.complete(request as never)).rejects.toBeDefined();
    expect(received.length).toBe(1);
  });
});
