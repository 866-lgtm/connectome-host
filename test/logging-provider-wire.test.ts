/**
 * llm-call records from the provider-agnostic wrapper carry the actual wire
 * body as `rawRequest` (captured through membrane's onRequest hook, as the
 * Anthropic and Bedrock writers do) beside the ProviderRequest as
 * `normalizedRequest` and the ProviderResponse as `normalizedResponse`.
 *
 * Wire-level fields (prompt_cache_key, prompt_cache_retention,
 * reasoning_effort, a forced think tool_choice) exist only in the wire body,
 * and a dropped-text check can diff normalizedRequest.messages against
 * rawRequest.messages to catch text an adapter silently drops. Exercised
 * here through the real OpenAI-compatible adapter against a local fake
 * endpoint, so the wire body is what membrane actually builds.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleAdapter } from '@animalabs/membrane';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import { LoggingProviderAdapter, stripInlineMedia } from '../src/logging-provider-wrapper.js';

const BIG_B64 = 'iVBORw0KGgo' + 'A'.repeat(64 * 1024);

const completion = {
  id: 'chatcmpl-zz',
  object: 'chat.completion',
  model: 'gpt-5.1',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'zz-answer' } }],
  usage: { prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 100 } },
};

function sse(): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-zz', object: 'chat.completion.chunk', model: 'gpt-5.1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ role: 'assistant', content: 'zz-' })
    + chunk({ content: 'answer' })
    + chunk({}, 'stop')
    + `data: ${JSON.stringify({ id: 'chatcmpl-zz', object: 'chat.completion.chunk', model: 'gpt-5.1', choices: [], usage: completion.usage })}\n\n`
    + 'data: [DONE]\n\n';
}

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;
let failNext = false;
const received: Array<Record<string, unknown>> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      received.push(body);
      if (failNext) {
        failNext = false;
        return new Response(JSON.stringify({ error: { message: 'zz bad request' } }), { status: 400 });
      }
      if (body.stream) return new Response(sse(), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json(completion);
    },
  });
  baseURL = `http://127.0.0.1:${server.port}/v1`;
});
afterAll(() => server.stop(true));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); received.length = 0; });

function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'logging-provider-wire-'));
  dirs.push(dir);
  return join(dir, 'llm-calls.jsonl');
}

function records(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
}

/** A representative agent request: text + image, a tool round, and a mixed
 *  tool_result+text envelope (the shape the dropped-text bug lost). */
function agentRequest(): ProviderRequest {
  return {
    model: 'gpt-5.1',
    maxTokens: 512,
    system: 'zz-system',
    cacheTtl: '24h',
    tools: [
      { name: 'think', description: 'think', inputSchema: { type: 'object', properties: { thought: { type: 'string' } } } },
      { name: 'send', description: 'send', inputSchema: { type: 'object', properties: {} } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'zz-user: look at this picture' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: BIG_B64 } },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'send', input: { text: 'zz-sent' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'zz-ok' },
          { type: 'text', text: 'zz-injected: a message that arrived mid-turn' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'zz-user: and now?' }] },
    ],
    extra: {
      prompt_cache_key: 'zz-agent',
      reasoning: { effort: 'high' },
      force_think_first: true,
    },
  } as unknown as ProviderRequest;
}

describe('LoggingProviderAdapter wire capture (openai-compatible)', () => {
  for (const kind of ['complete', 'stream'] as const) {
    test(`${kind}: rawRequest is the Chat Completions body; normalized request/response sit beside it`, async () => {
      const path = logFile();
      const seen: unknown[] = [];
      const wrapped = new LoggingProviderAdapter(new OpenAICompatibleAdapter({ baseURL, apiKey: 'zz' }), path);
      const request = agentRequest();
      const options = { onRequest: (req: unknown) => { seen.push(req); } };
      const response = kind === 'complete'
        ? await wrapped.complete(request, options)
        : await wrapped.stream(request, { onChunk: () => {} }, options);
      expect(response.stopReason).toBeDefined();

      // The caller's own onRequest (membrane's, in production) still sees the body.
      expect(seen.length).toBe(1);
      expect(received.length).toBe(1);

      const [record] = records(path);
      expect(record!.type).toBe('call');
      expect(record!.rawRequestSource).toBe('wire');

      // Wire body: what the endpoint received, base64 stripped.
      const wire = record!.rawRequest;
      expect(wire.model).toBe('gpt-5.1');
      expect(wire.prompt_cache_key).toBe('zz-agent');
      // The log holds exactly what the endpoint got (base64 stripped).
      // Which wire fields membrane derives from the request (24h ->
      // prompt_cache_retention, reasoning effort spelling, a forced think
      // tool_choice) depends on the membrane release; the logger must not.
      expect(wire).toEqual(JSON.parse(JSON.stringify(received[0], stripInlineMedia)));
      expect(wire.messages[0]).toEqual({ role: 'system', content: 'zz-system' });
      expect(wire.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user', 'user']);
      const sentImage = (received[0]!.messages as Array<{ content: unknown }>)[1]!.content as Array<{ image_url?: { url: string } }>;
      expect(sentImage[1]!.image_url!.url.length).toBeGreaterThan(64 * 1024);
      expect(wire.messages[1].content[1].image_url.url).toBe('data:image/png;base64,[stripped 64kb]');
      if (kind === 'stream') {
        expect(wire.stream).toBe(true);
        expect(wire.stream_options).toEqual({ include_usage: true });
      }

      // Small top-level params repeated outside the raw bodies; arrays are not.
      const sent = received[0]!;
      expect(record!.wireParams).toMatchObject({ model: 'gpt-5.1', prompt_cache_key: 'zz-agent' });
      for (const key of ['prompt_cache_retention', 'reasoning_effort', 'tool_choice'] as const) {
        expect(record!.wireParams[key]).toEqual(sent[key]);
      }
      expect(record!.wireParams.messages).toBeUndefined();
      expect(record!.wireParams.tools).toBeUndefined();

      // Normalized request: the ProviderRequest, base64 stripped too.
      const normalized = record!.normalizedRequest;
      expect(normalized.extra).toEqual({ prompt_cache_key: 'zz-agent', reasoning: { effort: 'high' }, force_think_first: true });
      expect(normalized.messages[0].content[1].source.data).toBe('[base64 stripped 64kb]');
      expect(normalized.messages[2].content[1].text).toBe('zz-injected: a message that arrived mid-turn');

      // Normalized response: the ProviderResponse without its raw bodies
      // (those are rawResponse / rawRequest already).
      expect(record!.normalizedResponse.stopReason).toBe(response.stopReason);
      expect(record!.normalizedResponse.content).toEqual(JSON.parse(JSON.stringify(response.content)));
      expect('raw' in record!.normalizedResponse).toBe(false);
      expect('rawRequest' in record!.normalizedResponse).toBe(false);

      // Upstream's fields are unchanged.
      expect(record!.requestSummary).toMatchObject({ model: 'gpt-5.1', messageCount: 4, toolNames: ['think', 'send'] });
      expect(record!.response.blocks).toEqual([{ type: 'text', chars: 9, text: 'zz-answer' }]);
      expect(record!.rawResponse).not.toBeNull();
    });
  }

  test('a failed call records the wire body it sent', async () => {
    const path = logFile();
    const wrapped = new LoggingProviderAdapter(new OpenAICompatibleAdapter({ baseURL, apiKey: 'zz' }), path);
    failNext = true;
    await expect(wrapped.complete(agentRequest())).rejects.toBeDefined();
    const [record] = records(path);
    expect(record!.type).toBe('error');
    expect(record!.rawRequestSource).toBe('wire');
    expect(record!.rawRequest.prompt_cache_key).toBe('zz-agent');
    expect(record!.normalizedRequest.model).toBe('gpt-5.1');
    expect('normalizedResponse' in record!).toBe(false);
  });

  test('the reasoning kill switch is visible on the wire: no reasoning_effort when disabled', async () => {
    const path = logFile();
    const wrapped = new LoggingProviderAdapter(
      new OpenAICompatibleAdapter({ baseURL, apiKey: 'zz' }), path, () => ({ enabled: false }) as never,
    );
    await wrapped.complete(agentRequest());
    const [record] = records(path);
    expect(record!.rawRequest.reasoning_effort).toBeUndefined();
    expect(record!.normalizedRequest.extra.reasoning).toBeUndefined();
  });

  test('records satisfy a dropped-text check: every normalized text block is found on the wire', async () => {
    const path = logFile();
    await new LoggingProviderAdapter(new OpenAICompatibleAdapter({ baseURL, apiKey: 'zz' }), path).complete(agentRequest());
    // Text-block containment: each normalized text block's prefix must appear in the wire messages.
    let checked = 0;
    let dropped = 0;
    for (const rec of records(path)) {
      const norm = rec.normalizedRequest?.messages;
      const raw = rec.rawRequest?.messages;
      expect(norm?.length).toBeGreaterThan(0);
      expect(raw?.length).toBeGreaterThan(0);
      const wire = JSON.stringify(raw);
      for (const m of norm) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            checked++;
            if (!wire.includes(JSON.stringify(b.text.slice(0, 120)).slice(1, -1))) dropped++;
          }
        }
      }
    }
    expect(checked).toBe(3);
    expect(dropped).toBe(0);
  });
});

describe('LoggingProviderAdapter wire capture (generic adapters)', () => {
  const response = { content: [{ type: 'text', text: 'zz' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };

  test('an adapter that never reports its body keeps upstream\'s rawRequest (the ProviderRequest)', async () => {
    const path = logFile();
    const silent = {
      name: 'silent', usageCacheConvention: 'cache-excluded', requiresNativeResponsesInput: false,
      supportsModel: () => true,
      complete: async () => response as unknown as ProviderResponse,
      stream: async () => response as unknown as ProviderResponse,
    } as ProviderAdapter;
    const request = { model: 'm', maxTokens: 8, messages: [{ role: 'user', content: 'zz' }] } as unknown as ProviderRequest;
    await new LoggingProviderAdapter(silent, path).complete(request);
    const [record] = records(path);
    expect(record!.rawRequestSource).toBe('provider-request');
    expect(record!.rawRequest).toEqual(request as never);
    expect(record!.normalizedRequest).toEqual(request as never);
    expect('wireParams' in record!).toBe(false);
  });

  test('an adapter that reports its body only on the response still gets it logged as the wire body', async () => {
    const path = logFile();
    const body = { model: 'm', input: [{ role: 'user', content: 'zz' }], prompt_cache_key: 'k' };
    const responseOnly = {
      name: 'response-only', usageCacheConvention: 'cache-excluded', requiresNativeResponsesInput: false,
      supportsModel: () => true,
      complete: async () => ({ ...response, rawRequest: body, raw: { id: 'r' } }) as unknown as ProviderResponse,
      stream: async () => { throw new Error('unused'); },
    } as ProviderAdapter;
    await new LoggingProviderAdapter(responseOnly, path).complete({ model: 'm', messages: [] } as unknown as ProviderRequest);
    const [record] = records(path);
    expect(record!.rawRequestSource).toBe('wire');
    expect(record!.rawRequest).toEqual(body);
    expect(record!.wireParams).toEqual({ model: 'm', prompt_cache_key: 'k' });
    expect(record!.rawResponse).toEqual({ id: 'r' });
  });

  test('a caller hook that throws propagates as it would unwrapped', async () => {
    const reporting = {
      name: 'reporting', usageCacheConvention: 'cache-excluded', requiresNativeResponsesInput: false,
      supportsModel: () => true,
      complete: async (req: ProviderRequest, options?: { onRequest?: (r: unknown) => void }) => {
        options?.onRequest?.({ wire: true, model: req.model });
        return response as unknown as ProviderResponse;
      },
      stream: async () => { throw new Error('unused'); },
    } as unknown as ProviderAdapter;
    const path = logFile();
    const hookError = new Error('zz hook failed');
    await expect(new LoggingProviderAdapter(reporting, path).complete(
      { model: 'm', messages: [] } as unknown as ProviderRequest,
      { onRequest: () => { throw hookError; } },
    )).rejects.toBe(hookError);
    const [record] = records(path);
    expect(record!.type).toBe('error');
    expect(record!.rawRequest).toEqual({ wire: true, model: 'm' });
  });

  test('the size guard drops the normalized bodies with the raw ones and keeps wireParams', async () => {
    const path = logFile();
    const huge = 'h '.repeat(9 * 1024 * 1024);
    const reporting = {
      name: 'reporting', usageCacheConvention: 'cache-excluded', requiresNativeResponsesInput: false,
      supportsModel: () => true,
      complete: async (req: ProviderRequest, options?: { onRequest?: (r: unknown) => void }) => {
        options?.onRequest?.({ model: req.model, messages: req.messages, prompt_cache_key: 'k' });
        return response as unknown as ProviderResponse;
      },
      stream: async () => { throw new Error('unused'); },
    } as unknown as ProviderAdapter;
    await new LoggingProviderAdapter(reporting, path).complete(
      { model: 'm', messages: [{ role: 'user', content: huge }] } as unknown as ProviderRequest,
    );
    const [record] = records(path);
    expect(record!.truncated).toBe('raw bodies dropped (record exceeded size guard)');
    for (const field of ['rawRequest', 'rawResponse', 'normalizedRequest', 'normalizedResponse']) {
      expect(field in record!).toBe(false);
    }
    expect(record!.wireParams).toEqual({ model: 'm', prompt_cache_key: 'k' });
    expect(record!.rawRequestSource).toBe('wire');
  });
});
