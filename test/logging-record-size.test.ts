import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.ISSUE341_SOURCE_ROOT ?? join(import.meta.dir, '..');
if (!root) throw Error('missing independently selected source root');
const { LoggingAnthropicAdapter } = await import(pathToFileURL(join(root, 'src/logging-adapter.ts')).href);
const { LoggingBedrockAdapter } = await import(pathToFileURL(join(root, 'src/logging-bedrock-adapter.ts')).href);
const { LoggingProviderAdapter } = await import(pathToFileURL(join(root, 'src/logging-provider-wrapper.ts')).href);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const CAP = 16 * 1024 * 1024;
const factories = {
  anthropic: (p: string) => new LoggingAnthropicAdapter({ apiKey: 'unit-test' }, p),
  bedrock: (p: string) => new LoggingBedrockAdapter({ region: 'us-east-1', accessKeyId: 'unit-test', secretAccessKey: 'unit-test' } as never, p),
  generic: (p: string) => new LoggingProviderAdapter({ name: 'unit-test', supportsModel: () => true } as never, p),
};
const head = { type: 'error', provider: 'unit-test', kind: 'stream', timestamp: '2026-10-19T00:00:00.000Z', durationMs: 3, error: 'invalid request', errorType: 'invalid_request', httpStatus: 400, retryable: false };
function emit(make: (p: string) => unknown, record: object) {
  const d = mkdtempSync(join(tmpdir(), 'issue341-regression-')); dirs.push(d);
  const p = join(d, 'llm-calls.test.jsonl');
  (make(p) as { log(r: object): void }).log(record);
  const bytes = readFileSync(p);
  expect(bytes[bytes.length - 1]).toBe(10);
  const parsed = JSON.parse(bytes.toString('utf8'));
  return { bytes, parsed };
}
for (const [name, make] of Object.entries(factories)) {
  test(`${name}: cap counts UTF8 bytes and preserves error classification after dropping raw bodies`, () => {
    const record = { ...head, requestSummary: { model: 'unit-test', messageCount: 1 }, rawRequest: '界'.repeat(6_000_000) };
    const { bytes, parsed } = emit(make, record);
    expect(bytes.byteLength).toBeLessThanOrEqual(CAP);
    expect(parsed).toMatchObject(head);
    expect(parsed.requestSummary).toEqual(record.requestSummary);
    expect(parsed.rawRequest).toBeUndefined();
    expect(typeof parsed.truncated).toBe('string');
  });
  test(`${name}: oversized summaries cannot bypass the final byte cap`, () => {
    const { bytes, parsed } = emit(make, { ...head, requestSummary: { toolNames: ['界'.repeat(6_000_000)] }, rawRequest: 'small' });
    expect(bytes.byteLength).toBeLessThanOrEqual(CAP);
    expect(parsed).toMatchObject(head);
    expect(typeof parsed.truncated).toBe('string');
  });
  test(`${name}: ordinary records retain their exact serialized shape`, () => {
    const record = { ...head, requestSummary: { model: 'unit-test' }, rawRequest: { diagnostic: true }, rawResponse: { ok: false } };
    const { bytes, parsed } = emit(make, record);
    expect(parsed).toEqual(record);
    expect(bytes.toString('utf8')).toBe(JSON.stringify(record) + '\n');
  });
  test(`${name}: an unserializable raw body retains an actionable error record`, () => {
    const cycle: any = {}; cycle.self = cycle;
    const { bytes, parsed } = emit(make, { ...head, requestSummary: { model: 'unit-test' }, rawRequest: cycle });
    expect(bytes.byteLength).toBeLessThanOrEqual(CAP);
    expect(parsed).toMatchObject(head);
    expect(parsed.rawRequest).toBeUndefined();
    expect(typeof parsed.truncated).toBe('string');
  });
}
