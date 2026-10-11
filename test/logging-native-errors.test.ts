import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter, BedrockAdapter, MembraneError } from '@animalabs/membrane';
import type { ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { LoggingBedrockAdapter } from '../src/logging-bedrock-adapter.js';
import type { ProviderCallRecord } from '../src/call-ledger.js';

// The Anthropic and Bedrock writers keep their records' `error` shape
// ({ name, message } for an Error, Anthropic's with `stack`), but bound its
// text as the generic decorator does: a provider can echo the whole rejected
// request in its error, beside the raw request the record already keeps. And
// logging never changes what the caller gets: reading a hostile error, or a
// request the summary can't read, neither replaces the provider's error nor
// a successful response.

const request: ProviderRequest = { messages: [], model: 'claude-opus-4-6', maxTokens: 16 };
const dirs: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Makes the provider's own complete and stream throw `thrown`. */
function failWith(base: { prototype: object }, thrown: unknown): void {
  const proto = base.prototype as Record<string, unknown>;
  const { complete, stream } = proto;
  proto.complete = async () => { throw thrown; };
  proto.stream = async () => { throw thrown; };
  restores.push(() => { proto.complete = complete; proto.stream = stream; });
}

/** Makes the provider's own complete and stream resolve to `response`. */
function succeedWith(base: { prototype: object }, response: ProviderResponse): void {
  const proto = base.prototype as Record<string, unknown>;
  const { complete, stream } = proto;
  proto.complete = async () => response;
  proto.stream = async () => response;
  restores.push(() => { proto.complete = complete; proto.stream = stream; });
}

type Adapter = {
  complete: (request: ProviderRequest) => Promise<ProviderResponse>;
  stream: (request: ProviderRequest, callbacks: object) => Promise<ProviderResponse>;
  onProviderError?: (error: unknown) => void;
  onProviderSuccess?: () => void;
};

/** Each writer, with a request its own summary throws on: Anthropic's reads
 *  the message count, and Bedrock's the last message's blocks. Anthropic's
 *  is built with the call ledger's observer, as index.ts builds it. */
function writers(): Array<{ name: 'anthropic' | 'bedrock'; base: { prototype: object }; stack: boolean; hostile: ProviderRequest; make: (log: string, calls: ProviderCallRecord[]) => Adapter }> {
  return [
    {
      name: 'anthropic', base: AnthropicAdapter, stack: true,
      hostile: { ...request, messages: undefined } as unknown as ProviderRequest,
      make: (log, calls) => new LoggingAnthropicAdapter({ apiKey: 'test' }, log, undefined, (call) => calls.push(call)) as never,
    },
    {
      name: 'bedrock', base: BedrockAdapter, stack: false,
      hostile: { ...request, messages: [{ role: 'user', content: [null] }] } as unknown as ProviderRequest,
      make: (log) => new LoggingBedrockAdapter({ region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test' } as never, log) as never,
    },
  ];
}

function records(log: string): Array<Record<string, unknown>> {
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

/** A fresh log, the writer's adapter on it, and what its observers hear. */
function setup(w: ReturnType<typeof writers>[number]) {
  const dir = mkdtempSync(join(tmpdir(), 'llm-native-errors-'));
  dirs.push(dir);
  const log = join(dir, 'llm-calls.jsonl');
  const calls: ProviderCallRecord[] = [];
  const adapter = w.make(log, calls);
  const errors: unknown[] = [];
  let successes = 0;
  adapter.onProviderError = (error) => { errors.push(error); };
  adapter.onProviderSuccess = () => { successes++; };
  const call = (kind: 'complete' | 'stream', req: ProviderRequest = request) =>
    kind === 'complete' ? adapter.complete(req) : adapter.stream(req, {});
  return { log, calls, errors, successes: () => successes, call };
}

describe('the Anthropic and Bedrock writers\' error records', () => {
  for (const w of writers()) {
    for (const kind of ['complete', 'stream'] as const) {
      test(`${w.name} ${kind}: an echoed request in the error is bounded, the error rethrown as it was`, async () => {
        const { log, calls, call } = setup(w);
        const echo = 'x'.repeat(200_000);
        const thrown = Object.assign(new Error(`400 invalid request: ${echo}`), {
          type: 'invalid_request_error', httpStatus: 400, providerErrorCode: 'invalid_request', retryable: false,
        });
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        const error = record!.error as { name: string; message: string; stack?: string };
        expect(error.name).toBe('Error');
        expect(error.message.length).toBeLessThanOrEqual(4_000);
        expect(error.message).toStartWith('400 invalid request: xxx');
        expect(error.message).toContain('characters omitted]');
        expect(record!.errorChars).toBe(thrown.message.length);
        expect(record!.errorType).toBe('invalid_request_error');
        expect(record!.httpStatus).toBe(400);
        expect(record!.providerErrorCode).toBe('invalid_request');
        expect(record!.retryable).toBe(false);
        if (w.stack) {
          // The stack doesn't repeat the message, so its frames survive whole.
          expect(error.stack).toStartWith('Error: [the message above]\n');
          expect(error.stack).toContain('    at ');
          expect(error.stack!.length).toBeLessThan(4_000);
          // The ledger's live row reads the record's text, as a restored one does.
          expect(calls).toHaveLength(1);
          expect(calls[0]!.error).toBe(error.message);
        } else {
          expect('stack' in error).toBe(false);
        }
        expect(JSON.stringify(record).length).toBeLessThan(20_000);
      });

      test(`${w.name} ${kind}: a small error's name and message are recorded whole`, async () => {
        const { log, calls, call } = setup(w);
        const thrown = new TypeError('fetch failed');
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        const error = record!.error as Record<string, unknown>;
        expect(error.name).toBe('TypeError');
        expect(error.message).toBe('fetch failed');
        expect('errorChars' in record!).toBe(false);
        if (w.stack) {
          expect(error.stack).toStartWith('TypeError: [the message above]\n');
          expect(calls[0]!.error).toBe('fetch failed');
        }
      });

      test(`${w.name} ${kind}: a thrown value whose type test throws (a revoked Proxy) is rethrown, not replaced`, async () => {
        const { log, calls, errors, call } = setup(w);
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        failWith(w.base, proxy);
        await expect(call(kind)).rejects.toBe(proxy);
        const [record] = records(log);
        expect(record!.error).toBe('[error could not be read]');
        if (w.name === 'anthropic') {
          // The tap hears the value as thrown, and the ledger still gets the failed call.
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBe(proxy);
          expect(calls).toHaveLength(1);
          expect(calls[0]!.error).toBe('[error could not be read]');
        }
      });

      test(`${w.name} ${kind}: a rejection with undefined is recorded and observed as the failure it is`, async () => {
        const { log, calls, errors, successes, call } = setup(w);
        failWith(w.base, undefined);
        await expect(call(kind)).rejects.toBeUndefined();
        const [record] = records(log);
        expect(record!.type).toBe('error');
        expect(record!.error).toBe('undefined');
        if (w.name === 'anthropic') {
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBeUndefined();
          expect(successes()).toBe(0);
          expect(calls[0]!.error).toBe('undefined');
        }
      });

      test(`${w.name} ${kind}: a thrown string is bounded like a message`, async () => {
        const { log, call } = setup(w);
        const thrown = `upstream said: ${'y'.repeat(100_000)}`;
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        expect(typeof record!.error).toBe('string');
        expect((record!.error as string).length).toBeLessThanOrEqual(4_000);
        expect(record!.error as string).toStartWith('upstream said: yyy');
        expect(record!.error as string).toContain('characters omitted]');
        expect(record!.errorChars).toBe(thrown.length);
      });

      test(`${w.name} ${kind}: an Error whose every part throws when read is recorded, and rethrown`, async () => {
        const { log, call } = setup(w);
        const thrown = new Error('never read');
        for (const part of ['name', 'message', 'stack', 'type', 'httpStatus', 'providerErrorCode', 'retryable']) {
          Object.defineProperty(thrown, part, { get() { throw new Error(`${part} getter failed`); } });
        }
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        // An unreadable name is recorded as "Error", which the value is; an
        // unreadable message is marked; the rest is left out.
        expect(record!.error).toEqual({ name: 'Error', message: '[message could not be read]' });
        for (const field of ['errorType', 'httpStatus', 'providerErrorCode', 'retryable', 'errorChars']) {
          expect(field in record!).toBe(false);
        }
      });

      test(`${w.name} ${kind}: a long name is bounded like a classification code`, async () => {
        const { log, call } = setup(w);
        const thrown = new Error('short');
        thrown.name = `Custom${'N'.repeat(10_000)}Error`;
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        const error = record!.error as { name: string; stack?: string };
        expect(error.name.length).toBeLessThanOrEqual(128);
        expect(error.name).toStartWith('CustomNNN');
        expect(error.name).toContain('characters omitted]');
        if (w.stack) expect(error.stack).toStartWith(`${error.name}: [the message above]\n`);
      });
    }
  }

  // Nothing in a call's logging can replace the provider's error or its
  // response: not the error's reading, and not the request's summary either.
  // A record that can't be summarized is written minimal instead.
  for (const w of writers()) {
    for (const kind of ['complete', 'stream'] as const) {
      test(`${w.name} ${kind}: a failed call whose request the summary can't read is still recorded and observed`, async () => {
        const { log, calls, errors, call } = setup(w);
        const thrown = Object.assign(new Error('overloaded'), { type: 'overloaded', retryable: true });
        failWith(w.base, thrown);
        await expect(call(kind, w.hostile)).rejects.toBe(thrown);
        const [record] = records(log);
        expect(record).toMatchObject({
          type: 'error', kind, summaryUnavailable: true,
          error: { name: 'Error', message: 'overloaded' }, errorType: 'overloaded', retryable: true,
        });
        expect('requestSummary' in record!).toBe(false);
        if (w.name === 'anthropic') {
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBe(thrown);
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({ kind, messages: 0, error: 'overloaded' });
        }
      });

      test(`${w.name} ${kind}: a successful call whose request the summary can't read still returns its response`, async () => {
        const { log, calls, errors, successes, call } = setup(w);
        const response = {
          content: [{ type: 'text', text: 'hello' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 3, outputTokens: 2 },
          raw: { stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } },
        } as unknown as ProviderResponse;
        succeedWith(w.base, response);
        await expect(call(kind, w.hostile)).resolves.toBe(response);
        const [record] = records(log);
        expect(record).toMatchObject({ type: 'call', kind, summaryUnavailable: true });
        if (w.name === 'anthropic') {
          expect(successes()).toBe(1);
          expect(errors).toHaveLength(0);
          expect(calls).toHaveLength(1);
          expect(calls[0]!.error).toBeUndefined();
        }
      });
    }
  }

  // The stack's header is rewritten only when it is the error's own
  // "Name: message" line; any other stack keeps its text, bounded like the
  // message. Only the writer that records stacks reads one.
  test('anthropic: a real MembraneError echoing the request keeps its frames, not the echo', async () => {
    const { log } = setup(writers()[0]!);
    const thrown = new MembraneError({
      type: 'invalid_request', message: `400 invalid request: ${'x'.repeat(200_000)}`, retryable: false, httpStatus: 400,
    });
    failWith(AnthropicAdapter, thrown);
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    const [record] = records(log);
    const error = record!.error as { name: string; message: string; stack: string };
    expect(error.name).toBe('MembraneError');
    expect(error.stack).toStartWith('MembraneError: [the message above]\n');
    expect(error.stack).toContain('    at ');
    expect(error.stack).not.toContain('characters omitted]');
    expect(record).toMatchObject({ errorType: 'invalid_request', httpStatus: 400, retryable: false });
  });

  test('anthropic: a multi-line message\'s header is recognized whole', async () => {
    const { log } = setup(writers()[0]!);
    const thrown = new Error('first line\nsecond line');
    failWith(AnthropicAdapter, thrown);
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    const stack = (records(log)[0]!.error as { stack: string }).stack;
    expect(stack).toStartWith('Error: [the message above]\n    at ');
  });

  test('anthropic: a stack whose first line only begins with the header is kept as it is', async () => {
    const { log } = setup(writers()[0]!);
    const thrown = new Error('abc');
    Object.defineProperty(thrown, 'stack', { value: 'Error: abcdef\n    at frame (file.js:1:1)' });
    failWith(AnthropicAdapter, thrown);
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    expect((records(log)[0]!.error as { stack: string }).stack).toBe('Error: abcdef\n    at frame (file.js:1:1)');
  });

  test('anthropic: a missing or non-string stack is left out', async () => {
    for (const value of [undefined, 42]) {
      const { log } = setup(writers()[0]!);
      const thrown = new Error('no stack here');
      Object.defineProperty(thrown, 'stack', { value });
      failWith(AnthropicAdapter, thrown);
      const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
      await expect(adapter.complete(request)).rejects.toBe(thrown);
      expect(records(log)[0]!.error).toEqual({ name: 'Error', message: 'no stack here' });
      for (const restore of restores.splice(0)) restore();
    }
  });

  test('anthropic: a long stack that doesn\'t open with the message is bounded, with the omission stated', async () => {
    const { log } = setup(writers()[0]!);
    const thrown = new Error('short');
    Object.defineProperty(thrown, 'stack', { value: `Wrapped: ${'y'.repeat(50_000)}\n    at frame (file.js:1:1)` });
    failWith(AnthropicAdapter, thrown);
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    const [record] = records(log);
    const stack = (record!.error as { stack: string }).stack;
    expect(stack.length).toBeLessThanOrEqual(4_000);
    expect(stack).toStartWith('Wrapped: yyy');
    expect(stack).toContain('characters omitted]');
    expect(stack).toEndWith('    at frame (file.js:1:1)');
  });

  test('bedrock: a stack is never read', async () => {
    const { log } = setup(writers()[1]!);
    const thrown = new Error('short');
    let reads = 0;
    Object.defineProperty(thrown, 'stack', { get() { reads++; return 'never wanted'; } });
    failWith(BedrockAdapter, thrown);
    const adapter = new LoggingBedrockAdapter({ region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test' } as never, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    expect(reads).toBe(0);
    expect('stack' in (records(log)[0]!.error as object)).toBe(false);
  });
});
