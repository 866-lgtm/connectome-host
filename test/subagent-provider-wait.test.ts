/**
 * A subagent whose run the framework ended rather than sleep a provider's
 * stated wait (agent-framework 0.22.1 on: an ephemeral run sleeps a stated
 * wait of up to ten minutes, and ends at once on a longer one or on one it
 * can't read as a number) fails without a restart, since a restart would
 * call the provider again too soon. Other rate-limit errors stay transient.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

// The framework's two endings (statedWaitNotSlept), after the provider's own
// message. The last test checks them against the framework's own text.
const UNSLEPT = "429 rate_limit_error: try again later (the provider asked to wait 7200 s; an ephemeral run doesn't sleep a stated wait longer than 600 s, so it ends now)";
const UNSLEPT_NAN = "429 rate_limit_error (the provider's stated wait is not a number, and an ephemeral run sleeps only a stated wait of 600 s or less, so it ends now)";

type Classifier = { isTransientError(err: Error): boolean };

async function harness(fail: () => Error) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-wait-'));
  const membrane = new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() });
  // One retry, so a restart shows as a second run after a 5 s delay, well
  // inside the test's bound.
  const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock', defaultMaxTokens: 256, maxRetries: 1 });
  // The rate-limit cooldown is 30 s; nothing here depends on its length.
  (subagent as unknown as { rateLimitCooldownMs: number }).rateLimitCooldownMs = 0;
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });
  let runs = 0;
  const fw = framework as unknown as {
    runEphemeralToCompletion: (agent: unknown) => Promise<{ speech: string; toolCallsCount: number }>;
  };
  fw.runEphemeralToCompletion = async () => {
    runs++;
    throw fail();
  };
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

function call(tool: 'spawn' | 'fork', name: string): ToolCall {
  const input = tool === 'spawn'
    ? { name, systemPrompt: 'you are a test subagent', task: 'reply', sync: true }
    : { name, task: 'reply', sync: true };
  return { id: `test-${tool}-${name}`, name: tool, input, callerAgentName: 'parent' };
}

describe("a provider's stated wait that the framework won't sleep", () => {
  for (const tool of ['spawn', 'fork'] as const) {
    for (const [form, message, phrase] of [
      ['a long wait', UNSLEPT, 'the provider asked to wait 7200 s'],
      ['a wait that is not a number', UNSLEPT_NAN, "the provider's stated wait is not a number"],
    ] as const) {
      test(`fails a ${tool} with the framework's reason, without a restart (${form})`, async () => {
        const h = await harness(() => new Error(message));
        try {
          const res = await h.subagent.handleToolCall(call(tool, `waiter-${tool}`));
          expect(res.success).toBe(false);
          expect(h.runs()).toBe(1);
          expect(JSON.stringify(res)).toContain(phrase);
        } finally {
          await h.cleanup();
        }
      }, 15_000);
    }
  }

  test('is read from the end of the message, so the same words echoed earlier leave an error transient', () => {
    const mod = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock' }) as unknown as Classifier;
    expect(mod.isTransientError(new Error(UNSLEPT))).toBe(false);
    expect(mod.isTransientError(new Error(UNSLEPT_NAN))).toBe(false);
    const echo = `503 overloaded; the request read: "${UNSLEPT}" and more of the request after it`;
    expect(mod.isTransientError(new Error(echo))).toBe(true);
    expect(mod.isTransientError(new Error('429 Too Many Requests'))).toBe(true);
    expect(mod.isTransientError(new Error('rate_limit_error: try again later'))).toBe(true);
  });

  test("matches the framework's own endings, for a long wait, one that can't be represented and one that isn't a number", async () => {
    const h = await harness(() => new Error('unused'));
    try {
      // The framework's own text, from the installed package: if a release
      // rewords it, this fails, and the check above needs the new wording.
      const fw = h.framework as unknown as { statedWaitNotSlept(error: Error): string };
      const mod = h.subagent as unknown as Classifier;
      const stated = (retryAfterMs: number) => Object.assign(new Error('429 rate_limit_error: try again later'), {
        name: 'MembraneError', type: 'rate_limit', retryable: true, retryAfterMs,
      });
      // Each case's own words, so a framework that stopped reading the stand-in
      // as a MembraneError, and gave every case one ending, fails here.
      for (const [wait, words] of [
        [7_200_000, 'the provider asked to wait 7200 s'],
        [Number.POSITIVE_INFINITY, 'the provider asked to wait longer than can be represented'],
        [Number.NaN, "the provider's stated wait is not a number"],
      ] as const) {
        const text = fw.statedWaitNotSlept(stated(wait));
        expect(text.startsWith('429 rate_limit_error: try again later (')).toBe(true);
        expect(text).toContain(words);
        expect(mod.isTransientError(new Error(text))).toBe(false);
      }
    } finally {
      await h.cleanup();
    }
  });
});
