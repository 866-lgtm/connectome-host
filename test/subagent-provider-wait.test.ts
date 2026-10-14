/**
 * A subagent whose run the framework ended rather than sleep a provider's
 * stated wait (agent-framework 0.22.1 on: an ephemeral run sleeps a stated
 * wait of up to ten minutes, and ends at once on a longer one) fails without
 * a restart, since a restart would call the provider again inside the wait it
 * asked for. Other rate-limit errors stay transient.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

// The framework's two endings (statedWaitNotSlept), after the provider's own message.
const UNSLEPT = "429 rate_limit_error: try again later (the provider asked to wait 7200 s; an ephemeral run doesn't sleep a stated wait longer than 600 s, so it ends now)";
const UNSLEPT_NAN = "429 rate_limit_error (the provider's stated wait is not a number, and an ephemeral run sleeps only a stated wait of 600 s or less, so it ends now)";

async function harness(fail: () => Error) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-wait-'));
  const membrane = new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock', defaultMaxTokens: 256, maxRetries: 2 });
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
    subagent,
    runs: () => runs,
    cleanup: async () => {
      try { await framework.stop(); } catch { /* noop */ }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function spawn(name: string): ToolCall {
  return { id: `test-${name}`, name: 'spawn', input: { name, systemPrompt: 'you are a test subagent', task: 'reply', sync: true }, callerAgentName: 'parent' };
}

describe("a provider's stated wait that the framework won't sleep", () => {
  test('fails the subagent with the framework\'s reason, without a restart', async () => {
    const h = await harness(() => new Error(UNSLEPT));
    try {
      const res = await h.subagent.handleToolCall(spawn('waiter'));
      expect(res.success).toBe(false);
      expect(h.runs()).toBe(1);
      expect(JSON.stringify(res)).toContain('the provider asked to wait 7200 s');
    } finally {
      await h.cleanup();
    }
  }, 15_000);

  test('is not transient in either of its forms, while another rate-limit error still is', () => {
    const mod = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock' }) as unknown as {
      isTransientError(err: Error): boolean;
    };
    expect(mod.isTransientError(new Error(UNSLEPT))).toBe(false);
    expect(mod.isTransientError(new Error(UNSLEPT_NAN))).toBe(false);
    expect(mod.isTransientError(new Error('429 Too Many Requests'))).toBe(true);
    expect(mod.isTransientError(new Error('rate_limit_error: try again later'))).toBe(true);
  });
});
