/**
 * The subagent module's retries, its time limit and its concurrency limit.
 *
 * - Its own failures (a prompt over its limit, its own time limit) end the
 *   retry loop without their words being read, and the framework's
 *   failures are read without the ephemeral agent's name in them, which
 *   holds the name the agent chose. Before, a subagent named "migrate"
 *   (which holds "rate") counted as a rate limit and halved concurrency, one
 *   named "idle-watch" counted as transient, and a 1500 ms limit (which
 *   holds "500") was retried.
 * - At its time limit a run is stopped, not left working untracked.
 * - Raising the concurrency limit lets a waiting spawn start, except while a
 *   rate limit's halving holds.
 * - A sync run moves to the background at its timeoutMs and goes on; only an
 *   async run's timeoutMs is a hard limit, and it covers the retries.
 * - Slots are released once, and waiting spawns start wherever the limit
 *   rises or a slot frees.
 * - A run not started by its deadline is dropped by the framework and
 *   reported as the time limit; one whose setup outlasts it isn't started.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

type Internal = {
  rateLimitCooldownMs: number;
  onRateLimitHit(): Promise<void>;
  asyncHandles: Map<string, { promise: Promise<unknown> }>;
  activeSubagents: Map<string, { lastActivityAt: number; status: string }>;
  cancellationHandles: Map<string, unknown>;
  acquireSlot(slotTimeoutMs?: number): Promise<{ waitedMs: number; slot: object }>;
  releaseSlot(slot: object): void;
  persistState(): void;
  effectiveConcurrent: number;
  configuredMaxConcurrent: number;
  consecutiveSuccesses: number;
  throttled: boolean;
  reclaimZombieSlots(): number;
  stopRun(agent: unknown): void;
  withTimeout<T>(p: Promise<T>, name: string, limitMs: number, deadline: number, stop: () => void): Promise<T>;
  isRateLimitError(err: Error): boolean;
  isTransientError(err: Error): boolean;
};
const internal = (s: SubagentModule) => s as unknown as Internal;

interface Harness {
  framework: AgentFramework;
  subagent: SubagentModule;
  runs(): number;
  cleanup(): Promise<void>;
}

/** What the module gives the framework's run of an ephemeral agent. */
type Watchdogs = { startupTimeoutMs?: number } | undefined;
type Run = (agent: { name: string }, contextManager: unknown, watchdogs: Watchdogs) => Promise<{ speech: string; toolCallsCount: number }>;

/** `run` stands in for the framework's run of each ephemeral agent; left
 *  out, the framework runs it against the mock provider. */
async function harness(
  config: ConstructorParameters<typeof SubagentModule>[0],
  run?: Run,
  adapter = new MockAdapter({ defaultResponse: 'ok' }),
): Promise<Harness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-own-'));
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock', defaultMaxTokens: 256, ...config });
  // The rate-limit cooldown is 30 s; nothing here depends on its length.
  (subagent as unknown as Internal).rateLimitCooldownMs = 0;
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });
  let runs = 0;
  const fw = framework as unknown as {
    createEphemeralAgent: (c: unknown) => Promise<unknown>;
    runEphemeralToCompletion: Run;
    agents: Map<string, unknown>;
  };
  const create = fw.createEphemeralAgent.bind(fw);
  fw.createEphemeralAgent = (c) => { runs++; return create(c); };
  if (run) {
    fw.runEphemeralToCompletion = (agent, contextManager, watchdogs) => {
      // Registered by name while it runs, as the framework's own run does,
      // so a stop finds it.
      fw.agents.set(agent.name, agent);
      const ran = run(agent, contextManager, watchdogs);
      const drop = () => { if (fw.agents.get(agent.name) === agent) fw.agents.delete(agent.name); };
      ran.then(drop, drop);
      return ran;
    };
  }
  subagent.setFramework(framework);
  framework.start();
  return {
    framework,
    subagent,
    runs: () => runs,
    cleanup: async () => {
      try { await framework.stop(); } catch { /* noop */ }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function spawn(name: string, extra: Record<string, unknown> = {}): ToolCall {
  return { id: `t-${name}-${Math.random().toString(36).slice(2)}`, name: 'spawn', input: { name, systemPrompt: 'sp', task: 't', ...extra }, callerAgentName: 'parent' };
}

function fork(name: string, extra: Record<string, unknown> = {}): ToolCall {
  return { id: `t-${name}-${Math.random().toString(36).slice(2)}`, name: 'fork', input: { name, task: 't', ...extra }, callerAgentName: 'parent' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for what a step brings about rather than for a set time. */
async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await sleep(10);
}
/** The settled outcome of an async subagent, from its handle. */
async function outcome(h: Harness, name: string): Promise<{ ok: boolean; text: string }> {
  const handle = internal(h.subagent).asyncHandles.get(name);
  if (!handle) throw new Error(`no async handle for ${name}`);
  return handle.promise.then(
    (r) => ({ ok: true, text: (r as { summary: string }).summary }),
    (e) => ({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  );
}
/** Count each ephemeral agent's stops (cancelStream calls) and when they came. */
function countStops(h: Harness): number[] {
  const at: number[] = [];
  const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<{ agent: { cancelStream(): void } }> };
  const create = fw.createEphemeralAgent.bind(fw);
  fw.createEphemeralAgent = async (c) => {
    const made = await create(c);
    const cancel = made.agent.cancelStream.bind(made.agent);
    made.agent.cancelStream = () => { at.push(Date.now()); cancel(); };
    return made;
  };
  return at;
}

describe('the module\'s own failures end the retry loop without their words being read', () => {
  for (const name of ['migrate', 'idle-watch']) {
    test(`a prompt over the limit, for a subagent named ${name}, runs once and leaves concurrency alone`, async () => {
      const h = await harness({ maxPromptTokens: 10, maxRetries: 1 });
      try {
        const res = await h.subagent.handleToolCall(spawn(name, { sync: true }));
        expect(res.error ?? '').toContain(`Prompt too large for subagent ${name}`);
        expect(h.runs()).toBe(1);
        expect(h.subagent.getConcurrencyStatus().effective).toBe(5);
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  test('an async time limit of 1500 ms is not retried', async () => {
    const h = await harness({ maxRetries: 1 }, () => new Promise(() => { /* never settles */ }));
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 1500 }));
      const out = await outcome(h, 'scout');
      expect(out).toEqual({ ok: false, text: 'Subagent scout timed out after 1500ms' });
      expect(h.runs()).toBe(1);
    } finally { await h.cleanup(); }
  }, 20_000);
});

describe('a framework failure is read without the ephemeral agent\'s name, and numbers as whole numbers', () => {
  // agent-framework 0.22.1's startup watchdog, which quotes the agent's name.
  const watchdog = (agent: { name: string }) => new Error(
    `Ephemeral agent "${agent.name}" failed to start inference within 15000ms — zombie detected. ` +
    'The event loop may have stalled or the inference request was dropped.',
  );

  test('a subagent named migrate whose run the watchdog ended runs once and leaves concurrency alone', async () => {
    const h = await harness({ maxRetries: 1 }, async (agent) => { throw watchdog(agent); });
    try {
      const res = await h.subagent.handleToolCall(spawn('migrate', { sync: true }));
      expect(res.error ?? '').toContain('failed to start inference within 15000ms');
      expect(h.runs()).toBe(1);
      expect(h.subagent.getConcurrencyStatus().effective).toBe(5);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('control: a provider\'s own transient words are still retried', async () => {
    const h = await harness({ maxRetries: 1 }, async () => { throw new Error('503 overloaded: socket hang up'); });
    try {
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true }));
      expect(res.success).toBe(false);
      expect(h.runs()).toBe(2);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('the classifiers read status codes as whole numbers and rate limits by their phrases', async () => {
    const h = await harness({});
    try {
      const sub = internal(h.subagent);
      expect(sub.isTransientError(new Error('no activity for 1500s (threshold 900s)'))).toBe(false);
      expect(sub.isTransientError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
      expect(sub.isTransientError(new Error('status=529 overloaded'))).toBe(true);
      expect(sub.isRateLimitError(new Error('failed to generate a moderate answer'))).toBe(false);
      expect(sub.isRateLimitError(new Error('waited 14290ms'))).toBe(false);
      expect(sub.isRateLimitError(new Error('rate_limit_error: slow down'))).toBe(true);
      expect(sub.isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
      expect(sub.isRateLimitError(new Error('Rate exceeded'))).toBe(true);
      expect(sub.isRateLimitError(new Error('upstream_rate_limit_exceeded'))).toBe(true);
      expect(sub.isRateLimitError(new Error('x-ratelimit-remaining: 0'))).toBe(true);
      expect(sub.isRateLimitError(new Error('Too many concurrent requests'))).toBe(true);
      expect(sub.isRateLimitError(new Error('the answer was rated poorly, rather than ratio'))).toBe(false);
      expect(sub.isRateLimitError(new Error('too many tokens in the prompt'))).toBe(false);
    } finally { await h.cleanup(); }
  });
});

describe('a sync run moves to the background at its timeoutMs and goes on', () => {
  test('with timeoutMs, the call answers "moved to background", the run is not stopped, and its result arrives', async () => {
    const h = await harness({ maxRetries: 0 }, () => sleep(700).then(() => ({ speech: 'done', toolCallsCount: 0 })));
    const stops = countStops(h);
    try {
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true, timeoutMs: 200 }));
      expect(String(res.data)).toContain('moved to background');
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'done' });
      expect(stops).toEqual([]);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('without timeoutMs, it moves at maxExecutionMs, the default, and isn\'t stopped there either', async () => {
    const h = await harness({ maxRetries: 0, maxExecutionMs: 200 }, () => sleep(700).then(() => ({ speech: 'done', toolCallsCount: 0 })));
    const stops = countStops(h);
    try {
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true }));
      expect(String(res.data)).toContain('moved to background');
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'done' });
      expect(stops).toEqual([]);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a sync fork does the same', async () => {
    const h = await harness({ maxRetries: 0 }, () => sleep(700).then(() => ({ speech: 'done', toolCallsCount: 0 })));
    const stops = countStops(h);
    try {
      const res = await h.subagent.handleToolCall(fork('probe', { sync: true, timeoutMs: 200 }));
      expect(String(res.data)).toContain('moved to background');
      expect(await outcome(h, 'probe')).toEqual({ ok: true, text: 'done' });
      expect(stops).toEqual([]);
    } finally { await h.cleanup(); }
  }, 20_000);
});

describe('an async run is stopped at its time limit, which covers its retries', () => {
  test('no more of its stream arrives after the stop, and the framework lets the run go', async () => {
    // 60 one-character chunks 100 ms apart: about 6 s of streaming.
    const adapter = new MockAdapter({ defaultResponse: 'x'.repeat(60), streamChunkSize: 1, streamChunkDelayMs: 100 });
    const h = await harness({ maxRetries: 0 }, undefined, adapter);
    const stops = countStops(h);
    const tokensAt: number[] = [];
    h.framework.onTrace((e) => {
      const ev = e as { type: string; agentName?: string };
      if (ev.type === 'inference:tokens' && ev.agentName?.startsWith('spawn-scout-')) tokensAt.push(Date.now());
    });
    const runs = (h.framework as unknown as { ephemeralRuns: Map<string, unknown> }).ephemeralRuns;
    const live = () => [...runs.keys()].filter((k) => k.startsWith('spawn-scout-'));
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 1000 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: false, text: 'Subagent scout timed out after 1000ms' });
      expect(tokensAt.length).toBeGreaterThan(0);
      expect(stops.length).toBeGreaterThan(0); // the limit stopped the run
      // The framework lets the run go well before its stream would have
      // ended by itself, about 6 s in.
      await until(() => live().length === 0, 2_000);
      expect(live()).toEqual([]);
      // Once the framework has let the run go, it drops the stream's later
      // events unread (agent-framework 0.22.1, driveStream's check that the
      // agent still owns its name), so the count is final. At most a chunk
      // already on its way when the stream was cancelled.
      const stoppedAt = stops[0]!;
      expect(tokensAt.filter((t) => t > stoppedAt).length).toBeLessThanOrEqual(1);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a run that ends before its limit is not stopped later by its timer', async () => {
    const h = await harness({ maxRetries: 0 }, () => sleep(20).then(() => ({ speech: 'ok', toolCallsCount: 0 })));
    const stops = countStops(h);
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 1500 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'ok' });
      await sleep(1700);
      expect(stops).toEqual([]);
    } finally { await h.cleanup(); }
  });

  test('a retry that couldn\'t start within the limit isn\'t started, and the failure is reported', async () => {
    let attempts = 0;
    const h = await harness({ maxRetries: 1 }, async () => { attempts++; await sleep(50); throw new Error('503 overloaded'); });
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 3000 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: false, text: '503 overloaded' });
      expect(attempts).toBe(1); // the retry's 5 s back-off would end past the 3 s limit
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a retry that starts within the limit gets only what is left of it', async () => {
    const given: Watchdogs[] = [];
    const h = await harness({ maxRetries: 1 }, async (_agent, _cm, watchdogs) => {
      given.push(watchdogs);
      if (given.length === 1) { await sleep(50); throw new Error('503 overloaded'); }
      return new Promise(() => { /* never settles */ });
    });
    try {
      const started = Date.now();
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 6000 }));
      const out = await outcome(h, 'scout');
      const took = Date.now() - started;
      expect(out).toEqual({ ok: false, text: 'Subagent scout timed out after 6000ms' });
      expect(given).toHaveLength(2);
      // The retry started after the 5 s back-off with what was left, under
      // 1 s, where a fresh limit would have given it 6 s.
      expect(given[0]!.startupTimeoutMs!).toBeGreaterThan(5000);
      expect(given[1]!.startupTimeoutMs!).toBeLessThanOrEqual(1000);
      expect(took).toBeLessThan(8500); // a fresh limit would end at about 11 s
    } finally { await h.cleanup(); }
  }, 20_000);

  for (const kind of ['spawn', 'fork'] as const) {
    test(`a rate limit's cooldown ends at the run's limit, for a ${kind}`, async () => {
      const h = await harness({ maxRetries: 1 }, async () => { await sleep(1000); throw new Error('429 Too Many Requests'); });
      internal(h.subagent).rateLimitCooldownMs = 5000;
      const lines: string[] = [];
      const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
      try {
        const started = Date.now();
        await h.subagent.handleToolCall(kind === 'spawn' ? spawn('scout', { timeoutMs: 1500 }) : fork('scout', { timeoutMs: 1500 }));
        const out = await outcome(h, 'scout');
        const took = Date.now() - started;
        expect(out).toEqual({ ok: false, text: '429 Too Many Requests' });
        expect(h.runs()).toBe(1);
        // It cooled down for what was left of its limit, about 500 ms, not 5 s.
        const cooled = lines.map((l) => /cooling down (\d+)ms/.exec(l)?.[1]).filter((m) => m !== undefined).map(Number);
        expect(cooled).toHaveLength(1);
        expect(cooled[0]!).toBeLessThanOrEqual(500);
        expect(took).toBeLessThan(4000); // a whole cooldown would end at about 6 s
        expect(h.subagent.getConcurrencyStatus().effective).toBe(2); // the halving holds
      } finally {
        spy.mockRestore();
        await h.cleanup();
      }
    }, 20_000);
  }

  test('a run not started by its deadline is dropped by the framework\'s startup watchdog, and reported as the time limit', async () => {
    const given: Watchdogs[] = [];
    // As agent-framework 0.22.1 does: a run whose inference hasn't started
    // by its startup watchdog is rejected with the framework's own words.
    // Its timer fires a millisecond early, as Node's can, so it settles the
    // attempt before the module's own limit does.
    const h = await harness({ maxRetries: 1 }, (agent, _cm, watchdogs) => {
      given.push(watchdogs);
      const ms = watchdogs?.startupTimeoutMs ?? 30_000;
      return new Promise((_, reject) => setTimeout(() => reject(new Error(
        `Ephemeral agent "${agent.name}" failed to start inference within ${ms}ms — zombie detected. ` +
        'The event loop may have stalled or the inference request was dropped.',
      )), ms - 1));
    });
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 1500 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: false, text: 'Subagent scout timed out after 1500ms' });
      expect(h.runs()).toBe(1);
      expect(given).toHaveLength(1);
      expect(given[0]!.startupTimeoutMs!).toBeGreaterThan(1000);
      expect(given[0]!.startupTimeoutMs!).toBeLessThanOrEqual(1500);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a run without a limit leaves the framework\'s watchdogs as they are', async () => {
    const given: Watchdogs[] = [];
    const h = await harness({ maxRetries: 0 }, async (_agent, _cm, watchdogs) => {
      given.push(watchdogs);
      return { speech: 'ok', toolCallsCount: 0 };
    });
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'ok' });
      expect(given).toEqual([undefined]);
    } finally { await h.cleanup(); }
  });

  test('an async run\'s limit counts from when it holds a slot, not from the call', async () => {
    const given: Record<string, Watchdogs> = {};
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, (agent, _cm, watchdogs) => {
      const name = agent.name.split('-')[1]!;
      given[name] = watchdogs;
      return name === 'first'
        ? sleep(800).then(() => ({ speech: 'ok', toolCallsCount: 0 }))
        : new Promise(() => { /* never settles */ });
    });
    try {
      await h.subagent.handleToolCall(spawn('first'));
      await until(() => h.subagent.getConcurrencyStatus().active === 1);
      await h.subagent.handleToolCall(spawn('second', { timeoutMs: 1500 }));
      expect(await outcome(h, 'second')).toEqual({ ok: false, text: 'Subagent second timed out after 1500ms' });
      // It waited about 800 ms for its slot, and its limit started then.
      expect(given.second!.startupTimeoutMs!).toBeGreaterThan(1000);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a run whose setup outlasts its limit isn\'t started', async () => {
    let started = 0;
    const h = await harness({ maxRetries: 0 }, () => { started++; return new Promise(() => { /* never settles */ }); });
    try {
      const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<unknown> };
      const create = fw.createEphemeralAgent.bind(fw);
      fw.createEphemeralAgent = async (c) => { await sleep(700); return create(c); };
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 500 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: false, text: 'Subagent scout timed out after 500ms' });
      expect(started).toBe(0);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a fork with a 1500 ms limit is stopped once and not retried', async () => {
    const h = await harness({ maxRetries: 1 }, () => new Promise(() => { /* never settles */ }));
    const stops = countStops(h);
    try {
      await h.subagent.handleToolCall(fork('probe', { timeoutMs: 1500 }));
      expect(await outcome(h, 'probe')).toEqual({ ok: false, text: 'Subagent probe timed out after 1500ms' });
      expect(h.runs()).toBe(1);
      expect(stops).toHaveLength(1);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a fork whose prompt is over the limit runs once and leaves concurrency alone', async () => {
    const h = await harness({ maxPromptTokens: 10, maxRetries: 1 });
    try {
      const res = await h.subagent.handleToolCall(fork('migrate', { sync: true }));
      expect(res.error ?? '').toContain('Prompt too large for subagent migrate');
      expect(h.runs()).toBe(1);
      expect(h.subagent.getConcurrencyStatus().effective).toBe(5);
    } finally { await h.cleanup(); }
  }, 20_000);
});

describe('the stop', () => {
  test('cancels the live stream of an agent at a tool boundary, which cancelStream alone leaves', async () => {
    const h = await harness({});
    try {
      const calls: string[] = [];
      const agent = {
        state: { status: 'ready', stream: { cancel: () => calls.push('stream.cancel') } },
        cancelStream: () => calls.push('cancelStream'),
      };
      internal(h.subagent).stopRun(agent);
      expect(calls).toEqual(['stream.cancel', 'cancelStream']);
      calls.length = 0;
      internal(h.subagent).stopRun({ state: { status: 'streaming' }, cancelStream: () => calls.push('cancelStream') });
      expect(calls).toEqual(['cancelStream']);
    } finally { await h.cleanup(); }
  });

  test('sets the agent idle even when the stream\'s cancel throws, or there is no stream', async () => {
    const h = await harness({});
    try {
      const calls: string[] = [];
      const throwing = {
        state: { status: 'ready', stream: { cancel: () => { throw new Error('gone'); } } },
        cancelStream: () => calls.push('cancelStream'),
      };
      expect(() => internal(h.subagent).stopRun(throwing)).toThrow('gone');
      expect(calls).toEqual(['cancelStream']);
      calls.length = 0;
      internal(h.subagent).stopRun({ state: { status: 'ready' }, cancelStream: () => calls.push('cancelStream') });
      expect(calls).toEqual(['cancelStream']);
    } finally { await h.cleanup(); }
  });

  test('a user\'s cancel stops the run through it', async () => {
    const h = await harness({ maxRetries: 0 }, () => new Promise(() => { /* never settles */ }));
    try {
      const sub = internal(h.subagent);
      const stopped: unknown[] = [];
      const stop = sub.stopRun.bind(sub);
      sub.stopRun = (agent) => { stopped.push(agent); stop(agent); };
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => sub.cancellationHandles.has('scout'));
      expect(h.subagent.cancelSubagent('scout')).toBe(true);
      expect((await outcome(h, 'scout')).text).toContain('[Stopped by user]');
      expect(stopped).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  test('a stop that throws still ends the attempt at its limit, and is logged', async () => {
    const h = await harness({});
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      const never = new Promise<never>(() => {});
      const ended = await internal(h.subagent).withTimeout(never, 'scout', 50, Date.now() + 50, () => { throw new Error('boom'); })
        .then(() => 'resolved', (e: Error) => e.message);
      expect(ended).toBe('Subagent scout timed out after 50ms');
      expect(lines).toContain('[subagent] scout: stopping the run at its time limit failed: boom');
    } finally {
      spy.mockRestore();
      await h.cleanup();
    }
  });
});

describe('concurrency slots', () => {
  test('a spawn waiting for a slot starts when the limit rises', async () => {
    const order: string[] = [];
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, (agent) => new Promise((resolve) => {
      const ms = agent.name.startsWith('spawn-long-') ? 3000 : 50;
      setTimeout(() => { order.push(agent.name.split('-')[1]!); resolve({ speech: 'ok', toolCallsCount: 0 }); }, ms);
    }));
    try {
      await h.subagent.handleToolCall(spawn('long'));
      await until(() => h.subagent.getConcurrencyStatus().active === 1);
      await h.subagent.handleToolCall(spawn('short'));
      await until(() => h.subagent.getConcurrencyStatus().queued === 1);
      expect(h.subagent.getConcurrencyStatus()).toEqual({ configured: 1, effective: 1, active: 1, queued: 1 });
      const raised = await h.subagent.handleToolCall({ id: 't-c', name: 'concurrency', input: { maxConcurrent: 2 }, callerAgentName: 'parent' });
      expect(raised.data).toEqual({ configured: 2, effective: 2, active: 2, queued: 0 });
      const short = outcome(h, 'short');
      const long = outcome(h, 'long');
      await short;
      expect(order).toEqual(['short']);
      await long;
    } finally { await h.cleanup(); }
  }, 20_000);

  test('while a rate limit holds the limit down, a higher ceiling waits for successes, and the answer says so', async () => {
    const h = await harness({ maxConcurrent: 4 });
    try {
      await internal(h.subagent).onRateLimitHit();
      expect(h.subagent.getConcurrencyStatus().effective).toBe(2);
      h.subagent.setConcurrency(8);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({
        configured: 8,
        effective: 2,
        note: 'A rate limit holds the limit at 2. It rises by one after every three subagents that finish without error, up to 8.',
      });
      h.subagent.setConcurrency(1);
      expect(h.subagent.getConcurrencyStatus()).toEqual({ configured: 1, effective: 1, active: 0, queued: 0 });
      h.subagent.setConcurrency(3);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ configured: 3, effective: 3 });
    } finally { await h.cleanup(); }
  });

  test('once successes bring a halved limit back to the ceiling, a raise takes effect at once', async () => {
    const h = await harness({ maxConcurrent: 2, maxRetries: 0 }, () => sleep(5).then(() => ({ speech: 'ok', toolCallsCount: 0 })));
    try {
      await internal(h.subagent).onRateLimitHit();
      expect(h.subagent.getConcurrencyStatus().effective).toBe(1);
      // Three successes in a row raise the effective limit by one.
      for (let i = 0; i < 3; i++) await h.subagent.handleToolCall(spawn(`ok${i}`, { sync: true }));
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ configured: 2, effective: 2 });
      h.subagent.setConcurrency(5);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ configured: 5, effective: 5 });
    } finally { await h.cleanup(); }
  });

  test('a success that raises the limit starts every waiting spawn there\'s room for', async () => {
    const h = await harness({ maxConcurrent: 3, maxRetries: 0 }, (agent) => (agent.name.startsWith('spawn-short-')
      ? sleep(100).then(() => ({ speech: 'ok', toolCallsCount: 0 }))
      : new Promise(() => { /* holds its slot */ })));
    try {
      const sub = internal(h.subagent);
      sub.effectiveConcurrent = 2;
      sub.throttled = true;
      sub.consecutiveSuccesses = 2;
      await h.subagent.handleToolCall(spawn('long'));
      await h.subagent.handleToolCall(spawn('short'));
      await h.subagent.handleToolCall(spawn('w1'));
      await h.subagent.handleToolCall(spawn('w2'));
      await until(() => h.subagent.getConcurrencyStatus().queued === 2);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ effective: 2, active: 2, queued: 2 });
      await outcome(h, 'short');
      // The success raised the limit to 3 as its slot freed: both waiting spawns start.
      await until(() => h.subagent.getConcurrencyStatus().queued === 0);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ effective: 3, active: 3, queued: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a reclaimed zombie\'s slot is released once, and goes to a waiting spawn', async () => {
    const h = await harness({ maxConcurrent: 2, maxRetries: 0 }, () => new Promise(() => { /* holds its slot */ }));
    try {
      const sub = internal(h.subagent);
      await h.subagent.handleToolCall(spawn('zombie'));
      await h.subagent.handleToolCall(spawn('long'));
      await h.subagent.handleToolCall(spawn('waiting'));
      // Both runs have reached the point where a reclaim can end them.
      await until(() => h.subagent.getConcurrencyStatus().queued === 1
        && sub.cancellationHandles.has('zombie') && sub.cancellationHandles.has('long'));
      const stopped: unknown[] = [];
      const stop = sub.stopRun.bind(sub);
      sub.stopRun = (agent) => { stopped.push(agent); stop(agent); };
      sub.activeSubagents.get('spawn-zombie')!.lastActivityAt = Date.now() - 200_000;
      expect(sub.reclaimZombieSlots()).toBe(1);
      expect(stopped).toHaveLength(1);
      expect((await outcome(h, 'zombie')).text).toContain('[Terminated: zombie]');
      // The zombie's own finally found its slot released already.
      await until(() => h.subagent.getConcurrencyStatus().active === 2 && h.subagent.getConcurrencyStatus().queued === 0);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 2, queued: 0 });
      await sleep(50);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 2, queued: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a finished fork of the same name doesn\'t hide a stuck spawn from the reclaim', async () => {
    const h = await harness({ maxConcurrent: 2, maxRetries: 0 }, (agent) => (agent.name.startsWith('spawn-')
      ? new Promise(() => { /* holds its slot */ })
      : sleep(5).then(() => ({ speech: 'ok', toolCallsCount: 0 }))));
    try {
      const sub = internal(h.subagent);
      expect((await h.subagent.handleToolCall(fork('scout', { sync: true }))).success).toBe(true);
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => sub.cancellationHandles.has('scout'));
      sub.activeSubagents.get('spawn-scout')!.lastActivityAt = Date.now() - 200_000;
      expect(sub.reclaimZombieSlots()).toBe(1);
      expect((await outcome(h, 'scout')).text).toContain('[Terminated: zombie]');
      await until(() => h.subagent.getConcurrencyStatus().active === 0);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a waiter whose wait runs out takes the slot a last-chance reclaim frees, and leaves the others waiting', async () => {
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, () => new Promise(() => { /* holds its slot */ }));
    try {
      const sub = internal(h.subagent);
      await h.subagent.handleToolCall(spawn('zombie'));
      await until(() => sub.cancellationHandles.has('zombie'));
      const first = sub.acquireSlot(100); // gives up after 100 ms, unless a reclaim then frees a slot
      const second = sub.acquireSlot(10_000);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 1, queued: 2 });
      sub.activeSubagents.get('spawn-zombie')!.lastActivityAt = Date.now() - 200_000;
      const got = await first;
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 1, queued: 1 });
      sub.releaseSlot(got.slot);
      sub.releaseSlot((await second).slot);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a throw while the run registers still releases its slot', async () => {
    const h = await harness({ maxRetries: 0 });
    try {
      const sub = internal(h.subagent);
      const persist = sub.persistState.bind(sub);
      let failed = false;
      sub.persistState = () => {
        if (!failed && sub.activeSubagents.has('spawn-scout')) { failed = true; throw new Error('state store unavailable'); }
        persist();
      };
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true }));
      expect(failed).toBe(true);
      expect(res.success).toBe(false);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0 });
    } finally { await h.cleanup(); }
  });

  test('a run whose agent can\'t be created is marked failed and holds no slot', async () => {
    const h = await harness({ maxRetries: 0 });
    try {
      const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<unknown> };
      fw.createEphemeralAgent = async () => { throw new Error('agent store unavailable'); };
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true }));
      expect(res.success).toBe(false);
      expect(internal(h.subagent).activeSubagents.get('spawn-scout')).toMatchObject({ status: 'failed' });
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0 });
    } finally { await h.cleanup(); }
  });
});
