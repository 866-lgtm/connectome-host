import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter, BedrockAdapter } from '@animalabs/membrane';
import type { ProviderRequest } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { LoggingBedrockAdapter } from '../src/logging-bedrock-adapter.js';

// The Anthropic and Bedrock writers keep their records' `error` shape
// ({ name, message } for an Error, Anthropic's with `stack`), but bound its
// text as the generic decorator does: a provider can echo the whole rejected
// request in its error, beside the raw request the record already keeps. And
// reading a hostile error never throws, so the provider's error is what the
// caller gets.

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

function writers(): Array<{ name: string; base: { prototype: object }; stack: boolean; make: (log: string) => { complete: Function; stream: Function } }> {
  return [
    { name: 'anthropic', base: AnthropicAdapter, stack: true, make: (log) => new LoggingAnthropicAdapter({ apiKey: 'test' }, log) as never },
    { name: 'bedrock', base: BedrockAdapter, stack: false, make: (log) => new LoggingBedrockAdapter({ region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test' } as never, log) as never },
  ];
}

function records(log: string): Array<Record<string, unknown>> {
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('the Anthropic and Bedrock writers\' error records', () => {
  for (const w of writers()) {
    for (const kind of ['complete', 'stream'] as const) {
      test(`${w.name} ${kind}: an echoed request in the error is bounded, the error rethrown as it was`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'llm-native-errors-'));
        dirs.push(dir);
        const log = join(dir, 'llm-calls.jsonl');
        const echo = 'x'.repeat(200_000);
        const thrown = Object.assign(new Error(`400 invalid request: ${echo}`), {
          type: 'invalid_request_error', httpStatus: 400, providerErrorCode: 'invalid_request', retryable: false,
        });
        failWith(w.base, thrown);
        const adapter = w.make(log);
        const call = kind === 'complete' ? adapter.complete(request) : adapter.stream(request, {});
        await expect(call).rejects.toBe(thrown);
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
        } else {
          expect('stack' in error).toBe(false);
        }
        expect(JSON.stringify(record).length).toBeLessThan(20_000);
      });

      test(`${w.name} ${kind}: a small error is recorded whole, in the shape it always had`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'llm-native-errors-'));
        dirs.push(dir);
        const log = join(dir, 'llm-calls.jsonl');
        const thrown = new TypeError('fetch failed');
        failWith(w.base, thrown);
        const adapter = w.make(log);
        await expect(kind === 'complete' ? adapter.complete(request) : adapter.stream(request, {})).rejects.toBe(thrown);
        const [record] = records(log);
        const error = record!.error as Record<string, unknown>;
        expect(error.name).toBe('TypeError');
        expect(error.message).toBe('fetch failed');
        expect('errorChars' in record!).toBe(false);
        if (w.stack) expect(error.stack).toStartWith('TypeError: [the message above]\n');
      });

      test(`${w.name} ${kind}: a thrown value whose type test throws (a revoked Proxy) is rethrown, not replaced`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'llm-native-errors-'));
        dirs.push(dir);
        const log = join(dir, 'llm-calls.jsonl');
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        failWith(w.base, proxy);
        const adapter = w.make(log);
        const call = kind === 'complete' ? adapter.complete(request) : adapter.stream(request, {});
        await expect(call).rejects.toBe(proxy);
        const [record] = records(log);
        expect(record!.error).toBe('[error could not be read]');
      });
    }
  }
});
