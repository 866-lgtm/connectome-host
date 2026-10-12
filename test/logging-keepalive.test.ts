import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeepaliveCall, KeepaliveUsage, ProviderRequest } from '@animalabs/membrane';
import { LoggingAnthropicAdapter, type OffPathRefusal } from '../src/logging-adapter.js';
import { CallLedger, type ProviderCallRecord } from '../src/call-ledger.js';
import { isAuthFailure } from '../src/credential-state.js';

const model = 'claude-fable-5';
const request: ProviderRequest = {
  model, maxTokens: 64,
  system: [{ type: 'text', text: 'stable private prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [{ name: 'probe', description: 'fixture tool', input_schema: { type: 'object', properties: {} } }],
  extra: { output_config: { effort: 'high' } },
};
/** The same lineage (model, system and tools) after one more turn. */
const reseedRequest: ProviderRequest = {
  ...request,
  messages: [...request.messages, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'again' }] }],
};
const readUsage: KeepaliveUsage = {
  input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  service_tier: 'standard', inference_geo: 'global',
};

async function exercise(options: {
  usage?: KeepaliveUsage; fail?: boolean; pokes?: number;
  /** The failing poke's HTTP status: 400 (invalid request) unless given. */
  failStatus?: 400 | 401;
  /** The failing 400's message: 'fixture rejection' unless given. */
  failMessage?: string;
  /** A successful poke's stop_reason: max_tokens unless given. */
  pokeStopReason?: string;
  /** Each poke's outcome in turn, in place of pokeStopReason: a stop_reason,
   *  or 'error' for a 400. */
  pokeOutcomes?: string[];
  /** After this many receipts, a second real request with one more message,
   *  which membrane records in the same lineage in place of the first. */
  reseedAfter?: number;
  /** The log's directory appears only once the first receipt has been
   *  observed, so the seed's and the first poke's rows are lost. */
  logDirLater?: boolean;
  /** The off-path refusal observer throws the first time it hears one. */
  refusalThrowsOnce?: boolean;
  /** Run with LLM_CALLS_FULL_PAYLOADS set, which keeps every request. */
  fullPayloads?: boolean;
  observer?: (call: KeepaliveCall) => void | Promise<void>;
  ledgerThrows?: boolean;
  credentialThrows?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'logging-keepalive-'));
  const logDir = options.logDirLater ? join(dir, 'later') : dir;
  const path = join(logDir, 'llm-calls.test.jsonl');
  const wire: string[] = [];
  const seen: ProviderCallRecord[] = [];
  const events: string[] = [];
  /** What the credential monitor's taps heard, in order. */
  const credential: Array<{ kind: string; error?: unknown }> = [];
  /** What the off-path refusal dragnet heard, in order. */
  const refusals: OffPathRefusal[] = [];
  /** The `this` the caller's onCall ran with, per receipt. */
  const callerThis: unknown[] = [];
  let pokesAnswered = 0;
  const ledger = new CallLedger({ hydrate: false });
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  let receipts = 0;
  let adapter: LoggingAnthropicAdapter | undefined;
  let seedFinished!: () => void;
  /** The reseeding request, once it has been sent. */
  let reseeded: Promise<unknown> | undefined;
  const seeded = new Promise<void>(resolve => { seedFinished = resolve; });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const body = await req.text();
      wire.push(body);
      const poke = JSON.parse(body).max_tokens === 0;
      // A slow runner may fire the timer before the seed call returns. Order
      // fixture responses explicitly rather than assuming a fast seed request.
      if (poke) await seeded;
      const outcome = poke
        ? options.pokeOutcomes?.[pokesAnswered++] ?? options.pokeStopReason ?? 'max_tokens'
        : 'end_turn';
      if (poke && (options.fail || outcome === 'error')) {
        return options.failStatus === 401
          ? Response.json({ type: 'error', error: { type: 'authentication_error', message: 'fixture credential rejected' } }, { status: 401 })
          : Response.json({ type: 'error', error: { type: 'invalid_request_error', message: options.failMessage ?? 'fixture rejection' } }, { status: 400 });
      }
      return Response.json({
        id: 'msg_fixture', type: 'message', role: 'assistant', model,
        content: poke ? [] : [{ type: 'text', text: 'ok' }],
        stop_reason: outcome, stop_sequence: null,
        ...(outcome === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber' } } : {}),
        usage: poke ? (options.usage ?? readUsage) : {
          input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
          service_tier: 'standard', inference_geo: 'global',
        },
      });
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // The adapter reads the full-payload flag when it is constructed.
  const fullPayloadsBefore = process.env.LLM_CALLS_FULL_PAYLOADS;
  if (options.fullPayloads) process.env.LLM_CALLS_FULL_PAYLOADS = '1';
  try {
    adapter = new LoggingAnthropicAdapter({
      apiKey: 'fixture-key', baseURL: server.url.toString(),
      defaultHeaders: { 'x-private-fixture': 'never-in-ledger' },
      cacheKeepalive: {
        lanes: ['complete'], refreshAfterMs: 40, checkIntervalMs: 5,
        maxIdleMs: 10000,
        onEvent(event) { events.push(event.type); },
        onCall(call) {
          callerThis.push(this);
          receipts++;
          // The adapter has written this receipt's row (or lost it) by now.
          if (options.logDirLater && receipts === 1) mkdirSync(logDir);
          // Recorded at once, before the request goes out, so the lineage's
          // next poke replays it.
          if (receipts === options.reseedAfter) reseeded = adapter?.complete(reseedRequest);
          if (receipts >= (options.pokes ?? 1)) {
            adapter?.cacheKeepalive?.stop();
            finished();
          }
          return options.observer?.(call);
        },
      },
    }, path, undefined, record => {
      seen.push(record);
      ledger.record(record);
      if (options.ledgerThrows && record.kind === 'keepalive') throw new Error('fixture ledger observer');
    });
    // Wired as index.ts wires the credential monitor, after construction.
    adapter.onProviderError = (error, kind) => {
      credential.push({ kind, error });
      if (options.credentialThrows && kind === 'keepalive') throw new Error('fixture credential observer');
    };
    adapter.onProviderSuccess = (kind) => {
      credential.push({ kind });
      if (options.credentialThrows && kind === 'keepalive') throw new Error('fixture credential observer');
    };
    // Wired as index.ts wires the off-path refusal dragnet.
    adapter.onRefusal = (info) => {
      refusals.push(info);
      if (options.refusalThrowsOnce && refusals.length === 1) throw new Error('fixture refusal observer');
    };
    await adapter.complete(request);
    seedFinished();
    await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('keepalive receipt timed out')), 5000);
      }),
    ]);
    await reseeded;
    // Let isolated observer promises and onEvent finish before checking them.
    await Bun.sleep(0);
    const logs = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { wire, seen, events, credential, refusals, callerThis, logs, receipts, live: ledger.snapshot(), reloaded: new CallLedger({ dataDir: dir }).snapshot() };
  } finally {
    if (fullPayloadsBefore === undefined) delete process.env.LLM_CALLS_FULL_PAYLOADS;
    else process.env.LLM_CALLS_FULL_PAYLOADS = fullPayloadsBefore;
    seedFinished();
    if (timeout !== undefined) clearTimeout(timeout);
    adapter?.cacheKeepalive?.stop();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('keepalive calls reach the normal logs and spend ledger', () => {
  test('a real request seeds a timer poke with exact payload and cache-read usage', async () => {
    const result = await exercise();
    expect(result.receipts).toBe(1);
    expect(result.logs.map(r => r.kind)).toEqual(['complete', 'keepalive']);
    const poke = result.logs[1];
    expect(poke.type).toBe('call');
    expect(poke.requestSummary).toMatchObject({ model, maxTokens: 0, messages: 1, tools: 1, effort: 'high', cacheBreakpoints: 1, cacheTtls: ['1h'] });
    // Stamped when the send finished, as complete/stream rows are, and tied
    // to the lineage and lane it refreshed.
    const { key, lane, startedAt } = poke.keepalive;
    expect(typeof key).toBe('string');
    expect(lane).toBe('complete');
    expect(Date.parse(poke.timestamp)).toBe(startedAt + poke.durationMs);
    expect(poke.rawRequest).toBeUndefined();
    expect(poke.rawResponse.usage).toEqual(readUsage);
    expect(JSON.stringify(result.logs)).not.toContain('never-in-ledger');
    const expected = { ...JSON.parse(result.wire[0]), max_tokens: 0 };
    delete expected.stream;
    expect(result.wire[1]).toBe(JSON.stringify(expected));
    expect(result.seen[1]).toMatchObject({
      kind: 'keepalive', inputTokens: 7, outputTokens: 0, cacheReadTokens: 6000, cacheWriteTokens: 0,
      serviceTier: 'standard', inferenceGeo: 'global',
    });
    expect(result.live.rows[1]).toMatchObject({ kind: 'keepalive', originEstimate: 'keepalive', verdict: 'HIT' });
    expect(result.live.rows[1].cost!.total).toBeGreaterThan(0);
    expect(result.live.summary.calls).toBe(2);
    expect(result.reloaded).toEqual(result.live);
    expect(result.events).toContain('refreshed');
    // The credential monitor hears the poke as it hears the seed call.
    expect(result.credential).toEqual([{ kind: 'complete' }, { kind: 'keepalive' }]);
  });

  test('ineffective writes retain split cache buckets and contribute their actual cost', async () => {
    const usage = { ...readUsage, cache_read_input_tokens: 0, cache_creation_input_tokens: 6000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 5000 } };
    const result = await exercise({ usage });
    expect(result.logs[1].rawResponse.usage).toEqual(usage);
    expect(result.seen[1]).toMatchObject({ cacheWriteTokens: 6000, cacheWrite5mTokens: 1000, cacheWrite1hTokens: 5000, cacheWriteBucketsAuthoritative: true });
    expect(result.live.rows[1].cost!.cacheWrite5m).toBeGreaterThan(0);
    expect(result.live.rows[1].cost!.cacheWrite1h).toBeGreaterThan(0);
    expect(result.reloaded).toEqual(result.live);
    expect(result.events).toContain('ineffective');
  });

  test('failed pokes emit an error row without inventing usage or cost', async () => {
    const result = await exercise({ fail: true });
    expect(result.logs[1]).toMatchObject({ kind: 'keepalive', type: 'error', rawRequest: { max_tokens: 0 } });
    expect(result.logs[1].error.message).toContain('fixture rejection');
    expect(result.live.rows[1]).toMatchObject({ kind: 'keepalive', verdict: 'ERROR', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(result.live.rows[1].cost).toBeUndefined();
    expect(result.reloaded).toEqual(result.live);
    expect(result.events).toContain('error');
    // The credential monitor gets the failure, and a 400 isn't an auth verdict.
    expect(result.credential.map(c => c.kind)).toEqual(['complete', 'keepalive']);
    expect((result.credential[1].error as Error).message).toContain('fixture rejection');
    expect(isAuthFailure(result.credential[1].error)).toBe(false);
  });

  test("a failed poke's error is bounded as a complete or stream call's is, in the row and the ledger alike", async () => {
    // A provider can echo the whole rejected request in its error body.
    const result = await exercise({ fail: true, failMessage: `fixture rejection ${'x'.repeat(10_000)}` });
    const row = result.logs[1];
    expect(row).toMatchObject({ kind: 'keepalive', type: 'error', error: { name: expect.any(String) } });
    expect(row.error.message).toContain('fixture rejection');
    expect(row.error.message).toContain('characters omitted');
    expect(row.error.message.length).toBeLessThanOrEqual(4_000);
    expect(row.errorChars).toBeGreaterThan(10_000);
    expect(result.live.rows[1].error).toBe(row.error.message);
    expect(result.reloaded).toEqual(result.live);
  });

  test('a refused poke logs its request, as a refused turn does', async () => {
    const result = await exercise({ pokeStopReason: 'refusal' });
    expect(result.logs[1]).toMatchObject({ kind: 'keepalive', type: 'call', rawRequest: { max_tokens: 0 } });
    expect(result.reloaded).toEqual(result.live);
  });

  test("the refusal dragnet hears a lineage's refused request once, even after a poke of it succeeds, and one row keeps it whole", async () => {
    const result = await exercise({ pokes: 4, pokeOutcomes: ['refusal', 'refusal', 'max_tokens', 'refusal'] });
    const pokes = result.logs.slice(1);
    expect(pokes.map(r => r.rawResponse.stop_reason)).toEqual(['refusal', 'refusal', 'max_tokens', 'refusal']);
    const id = pokes[0].keepalive.request;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // The whole replayed prompt, most of it read from cache.
    expect(result.refusals).toEqual([
      { kind: 'keepalive', category: 'cyber', model, messages: 1, inputTokens: 6007, request: id },
    ]);
    // The first refused row keeps the request; the later ones name it.
    expect(JSON.stringify(pokes[0].rawRequest)).toBe(result.wire[1]);
    expect([pokes[1], pokes[3]].map(r => [r.keepalive.request, r.rawRequest])).toEqual([[id, undefined], [id, undefined]]);
    // A poke that succeeds names nothing.
    expect(pokes[2].keepalive.request).toBeUndefined();
    expect(result.reloaded).toEqual(result.live);
  });

  test("a real request that reseeds the lineage brings a new request, whose refusal is heard and kept afresh", async () => {
    const result = await exercise({ pokes: 2, pokeOutcomes: ['refusal', 'refusal'], reseedAfter: 1 });
    expect(result.logs.filter(r => r.kind === 'complete').map(r => r.requestSummary.messages)).toEqual([1, 3]);
    const [first, second] = result.logs.filter(r => r.kind === 'keepalive');
    expect(second.keepalive.key).toBe(first.keepalive.key);
    expect(second.keepalive.request).not.toBe(first.keepalive.request);
    expect(second.requestSummary.messages).toBe(3);
    expect(result.refusals.map(r => [r.messages, r.request])).toEqual([
      [1, first.keepalive.request], [3, second.keepalive.request],
    ]);
    expect([first.rawRequest, second.rawRequest].every(Boolean)).toBe(true);
  });

  test("a refused request whose whole row was lost is kept whole by the next row that replays it", async () => {
    const result = await exercise({ pokes: 2, pokeOutcomes: ['refusal', 'refusal'], logDirLater: true });
    // The seed's and the first poke's rows were lost; the second poke's row is the first written.
    expect(result.logs.map(r => r.kind)).toEqual(['keepalive']);
    expect(JSON.stringify(result.logs[0].rawRequest)).toBe(result.wire[2]);
    // The alert doesn't wait on the log.
    expect(result.refusals).toHaveLength(1);
  });

  test("an observer that throws hasn't heard the refusal: the next refused poke tries again, and the rows still reach the ledger", async () => {
    const result = await exercise({ pokes: 3, pokeOutcomes: ['refusal', 'refusal', 'refusal'], refusalThrowsOnce: true });
    expect(result.refusals).toHaveLength(2);
    expect(result.seen.map(r => r.kind)).toEqual(['complete', 'keepalive', 'keepalive', 'keepalive']);
  });

  test('a failing lineage keeps its request whole once, its errors in between and a refusal after it name it', async () => {
    const result = await exercise({ pokes: 3, pokeOutcomes: ['error', 'refusal', 'error'] });
    const pokes = result.logs.slice(1);
    expect(pokes.map(r => r.type)).toEqual(['error', 'call', 'error']);
    const id = pokes[0].keepalive.request;
    expect(pokes.map(r => r.keepalive.request)).toEqual([id, id, id]);
    expect(pokes.map(r => r.rawRequest === undefined)).toEqual([false, true, true]);
    // An error is no refusal, and doesn't end one: the refusal between them is heard once.
    expect(result.refusals.map(r => r.request)).toEqual([id]);
    expect(result.reloaded).toEqual(result.live);
  });

  test('with full payloads on, every poke keeps its request, a repeated refusal too', async () => {
    const result = await exercise({ fullPayloads: true, pokes: 3, pokeOutcomes: ['max_tokens', 'refusal', 'refusal'] });
    expect(result.logs.slice(1).map(r => r.type)).toEqual(['call', 'call', 'call']);
    for (const row of result.logs.slice(1)) expect(JSON.stringify(row.rawRequest)).toBe(result.wire[1]);
  });

  test("a poke whose credential is rejected reaches the credential monitor as an auth failure", async () => {
    const result = await exercise({ fail: true, failStatus: 401 });
    expect(result.logs[1]).toMatchObject({ kind: 'keepalive', type: 'error' });
    expect(result.reloaded).toEqual(result.live);
    expect(result.credential.map(c => c.kind)).toEqual(['complete', 'keepalive']);
    expect(isAuthFailure(result.credential[1].error)).toBe(true);
  });

  test('caller mutation and observer failures cannot change logged usage, the ledger or the next poke', async () => {
    const result = await exercise({ pokes: 2, ledgerThrows: true, credentialThrows: true, observer(call) {
      call.request.system = 'mutated';
      if (call.outcome === 'success') call.response.usage = { input_tokens: 99999 };
      throw new Error('fixture caller observer');
    } });
    expect(result.logs.map(r => r.kind)).toEqual(['complete', 'keepalive', 'keepalive']);
    expect(result.wire[2]).toBe(result.wire[1]);
    expect(result.logs[1].rawResponse.usage).toEqual(readUsage);
    expect(result.logs[2].rawResponse.usage).toEqual(readUsage);
    // A throwing credential observer doesn't keep the row from the ledger.
    expect(result.seen.map(r => r.kind)).toEqual(['complete', 'keepalive', 'keepalive']);
    // And a throwing ledger observer doesn't keep the poke from the credential monitor.
    expect(result.credential.map(c => c.kind)).toEqual(['complete', 'keepalive', 'keepalive']);
    expect(result.events.filter(event => event === 'refreshed')).toHaveLength(2);
  });

  test("a refused row's request and its name are the bytes sent, whatever the caller's observer does to its copy", async () => {
    const result = await exercise({ pokeOutcomes: ['refusal'], observer(call) { call.request.system = 'mutated'; } });
    const row = result.logs[1];
    expect(JSON.stringify(row.rawRequest)).toBe(result.wire[1]);
    expect(row.keepalive.request).toBe(createHash('sha256').update(result.wire[1]).digest('hex').slice(0, 16));
  });

  test("the caller's onCall runs as membrane's method, with its config as this", async () => {
    const result = await exercise();
    // membrane calls onCall on its own copy of the keepalive config, which
    // holds the caller's settings and membrane's defaults for the rest.
    const self = result.callerThis[0] as { refreshAfterMs?: number; maxLineages?: number } | undefined;
    expect(self?.refreshAfterMs).toBe(40);
    expect(self?.maxLineages).toBe(4);
  });

  test('caller async rejection remains isolated from the keepalive loop', async () => {
    const result = await exercise({ observer: async () => { throw new Error('fixture async observer'); } });
    expect(result.logs.map(r => r.kind)).toEqual(['complete', 'keepalive']);
    expect(result.events).toContain('refreshed');
  });
});

describe('the keepalive refusal dragnet and request retention, poke by poke', () => {
  /** A receipt as membrane reports it for lineage `key`, replaying a request of `messages` messages. */
  function receipt(key: string, messages: number, outcome: 'refusal' | 'max_tokens' | 'error', usage: KeepaliveUsage = readUsage): KeepaliveCall {
    const request = {
      model, max_tokens: 0, system: `system of ${key}`,
      messages: Array.from({ length: messages }, (_, i) => ({ role: 'user', content: `turn ${i}` })),
    };
    const base = { key, lane: 'stream' as const, startedAt: Date.now(), durationMs: 3, request };
    if (outcome === 'error') return { ...base, outcome: 'error', error: new Error('fixture rejection') };
    return {
      ...base, outcome: 'success',
      response: {
        id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: outcome,
        ...(outcome === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber' } } : {}),
        usage,
      },
    };
  }

  function withAdapter(run: (adapter: { log(call: KeepaliveCall): void; refusals: OffPathRefusal[]; rows(): Array<Record<string, any>> }) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'logging-keepalive-unit-'));
    const path = join(dir, 'llm-calls.unit.jsonl');
    try {
      const adapter = new LoggingAnthropicAdapter({ apiKey: 'fixture-key', cacheKeepalive: { enabled: false } }, path);
      const refusals: OffPathRefusal[] = [];
      adapter.onRefusal = (info) => { refusals.push(info); };
      run({
        // The receipt path membrane's onCall reaches, called directly.
        log: (call) => (adapter as unknown as { logKeepaliveCall(call: KeepaliveCall): void }).logKeepaliveCall(call),
        refusals,
        rows: () => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('after an append that may have left part of a row, the next row starts on a new line and keeps the request whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logging-keepalive-torn-'));
    const later = join(dir, 'later');
    const path = join(later, 'llm-calls.unit.jsonl');
    try {
      const adapter = new LoggingAnthropicAdapter({ apiKey: 'fixture-key', cacheKeepalive: { enabled: false } }, path);
      adapter.onRefusal = () => {};
      const log = (call: KeepaliveCall) => (adapter as unknown as { logKeepaliveCall(call: KeepaliveCall): void }).logKeepaliveCall(call);
      // The first append throws (no directory yet); what a write cut short
      // would have left is put there by hand.
      log(receipt('A', 1, 'refusal'));
      mkdirSync(later);
      const fragment = '{"type":"call","kind":"keepal';
      writeFileSync(path, fragment);
      log(receipt('A', 1, 'refusal'));
      log(receipt('A', 1, 'refusal'));
      // The fragment, then two whole rows, each on its own line and none blank.
      const lines = readFileSync(path, 'utf8').split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe(fragment);
      expect(lines[3]).toBe('');
      const rows = lines.slice(1, 3).map(line => JSON.parse(line));
      expect(rows.map(r => r.rawRequest !== undefined)).toEqual([true, false]);
      expect(rows[1].keepalive.request).toBe(rows[0].keepalive.request);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed poke keeps its lineage's kept request fresh, but not the refusal it was last heard for", () => {
    withAdapter(({ log, refusals, rows }) => {
      for (let i = 0; i < 16; i++) log(receipt(`L${i}`, 1, 'refusal'));
      // L0's same request fails: the kept requests count that as use, the refusal memory doesn't.
      log(receipt('L0', 1, 'error'));
      log(receipt('L16', 1, 'refusal'));
      expect(refusals).toHaveLength(17);
      log(receipt('L0', 1, 'refusal'));
      // Forgotten by the refusal memory, so heard again; still kept, so named only.
      expect(refusals).toHaveLength(18);
      expect(rows().at(-1)!.rawRequest).toBeUndefined();
    });
  });

  test("a row that couldn't be serialized leaves the file's lines as they were, and an append that wrote nothing leaves one blank line", () => {
    const dir = mkdtempSync(join(tmpdir(), 'logging-keepalive-lines-'));
    const later = join(dir, 'later');
    const path = join(later, 'llm-calls.unit.jsonl');
    try {
      const adapter = new LoggingAnthropicAdapter({ apiKey: 'fixture-key', cacheKeepalive: { enabled: false } }, path);
      adapter.onRefusal = () => {};
      const log = (call: KeepaliveCall) => (adapter as unknown as { logKeepaliveCall(call: KeepaliveCall): void }).logKeepaliveCall(call);
      mkdirSync(later);
      // A BigInt can't be serialized: no row, and the file isn't marked torn.
      log(receipt('A', 1, 'max_tokens', { ...readUsage, input_tokens: 1n as unknown as number }));
      log(receipt('A', 1, 'max_tokens'));
      expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(2);
      // An append that throws before writing anything leaves one blank line before the next row.
      rmSync(later, { recursive: true, force: true });
      log(receipt('A', 1, 'max_tokens'));
      mkdirSync(later);
      log(receipt('A', 1, 'max_tokens'));
      const lines = readFileSync(path, 'utf8').split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('');
      expect(JSON.parse(lines[1]!).kind).toBe('keepalive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('each lineage is heard and kept on its own', () => {
    withAdapter(({ log, refusals, rows }) => {
      for (const key of ['A', 'B', 'A', 'B']) log(receipt(key, 1, 'refusal'));
      expect(refusals).toHaveLength(2);
      expect(refusals[0].request).not.toBe(refusals[1].request);
      expect(rows().map(r => [r.keepalive.key, r.rawRequest !== undefined])).toEqual([['A', true], ['B', true], ['A', false], ['B', false]]);
    });
  });

  test("the alert's size is the whole prompt, cache writes included", () => {
    withAdapter(({ log, refusals }) => {
      log(receipt('A', 2, 'refusal', { ...readUsage, cache_creation_input_tokens: 50 }));
      expect(refusals).toEqual([{ kind: 'keepalive', category: 'cyber', model, messages: 2, inputTokens: 6057, request: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    });
  });

  test('past sixteen lineages the one noted longest ago is forgotten: its next refusal is heard and kept again', () => {
    withAdapter(({ log, refusals, rows }) => {
      for (let i = 0; i <= 16; i++) log(receipt(`L${i}`, 1, 'refusal'));
      expect(refusals).toHaveLength(17);
      log(receipt('L16', 1, 'refusal'));
      expect(refusals).toHaveLength(17);
      log(receipt('L0', 1, 'refusal'));
      expect(refusals).toHaveLength(18);
      expect(rows().at(-1)!.rawRequest).toBeDefined();
    });
  });

  test('a lineage still replaying its refused request stays remembered past sixteen others', () => {
    withAdapter(({ log, refusals, rows }) => {
      for (let i = 0; i < 16; i++) log(receipt(`L${i}`, 1, 'refusal'));
      // L0 is refused again on the same request: no alert, but it counts as used.
      log(receipt('L0', 1, 'refusal'));
      expect(refusals).toHaveLength(16);
      log(receipt('L16', 1, 'refusal'));
      log(receipt('L0', 1, 'refusal'));
      expect(refusals).toHaveLength(17);
      log(receipt('L1', 1, 'refusal'));
      expect(refusals).toHaveLength(18);
      // The kept requests are forgotten in the same order.
      const tail = rows().slice(-3);
      expect(tail.map(r => [r.keepalive.key, r.rawRequest !== undefined])).toEqual([['L16', true], ['L0', false], ['L1', true]]);
    });
  });

  test('a lineage noted again with a new request is the last to be forgotten', () => {
    withAdapter(({ log, refusals }) => {
      for (let i = 0; i < 16; i++) log(receipt(`L${i}`, 1, 'refusal'));
      // L0 reseeded: a new request, noted after the other fifteen.
      log(receipt('L0', 2, 'refusal'));
      log(receipt('L16', 1, 'refusal'));
      expect(refusals).toHaveLength(18);
      // L1 was forgotten, not L0, so L0's new request is still remembered.
      log(receipt('L0', 2, 'refusal'));
      expect(refusals).toHaveLength(18);
      log(receipt('L1', 1, 'refusal'));
      expect(refusals).toHaveLength(19);
    });
  });
});
