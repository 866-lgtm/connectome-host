/**
 * The health snapshot's per-agent sections read each agent on its own: one
 * agent whose read throws, such as one whose context manager a store surgery
 * left uninitialized, is left out of that section and named in readFailures,
 * and the others are still reported. An agent with nothing to report is left
 * out with no failure.
 */
import { describe, test, expect } from 'bun:test';
import { buildHealthSnapshot, type PanelAppRef } from '../src/web/panel-data.js';

const NOT_READY = 'context manager is not initialized';
const notReady = (): never => { throw new Error(NOT_READY); };

type Reads = { quarantine?: () => unknown; debt?: () => unknown; render?: () => unknown; settings?: () => unknown };

function agentStub(name: string, reads: Reads = {}) {
  return {
    name,
    settings: reads.settings ?? (() => ({ contextBudgetTokens: 100_000 })),
    getContextManager: () => ({
      getStrategy: () => ({
        getCompressionQuarantineStatus: reads.quarantine ?? (() => ({ quarantined: 1 })),
        getCompressionDebt: reads.debt ?? (() => ({ level: 'healthy' })),
      }),
      getRenderStats: reads.render ?? (() => ({ head: 10, tail: 20 })),
    }),
  };
}

const broken = (name: string) =>
  agentStub(name, { quarantine: notReady, debt: notReady, render: notReady, settings: notReady });

function appWith(agents: ReturnType<typeof agentStub>[]): PanelAppRef {
  const framework = {
    agents,
    healthSnapshot: () => ({ agents: agents.map((agent) => ({ name: agent.name })) }),
    getAllAgents() { return this.agents; },
    // A method, as the framework's is: it reads its own state through `this`.
    getAgentRuntimeSettings(name: string) {
      const agent = this.agents.find((a) => a.name === name);
      if (!agent) throw new Error(`Unknown agent: ${name}`);
      return agent.settings();
    },
  };
  return { framework, recipe: {} } as unknown as PanelAppRef;
}

describe('health snapshot per agent', () => {
  test('an agent whose reads throw is left out of each section and named in readFailures, and the others are reported', () => {
    const snapshot = buildHealthSnapshot(appWith([broken('broken'), agentStub('steady')]));
    expect(snapshot.runtimeSettings).toEqual({ steady: { contextBudgetTokens: 100_000 } });
    expect(snapshot.compressionQuarantine).toEqual({ steady: { quarantined: 1 } });
    expect(snapshot.compressionDebt).toEqual({ steady: { level: 'healthy' } });
    expect(snapshot.contextComposition).toEqual({ steady: { head: 10, tail: 20 } });
    expect(snapshot.readFailures).toEqual({
      broken: {
        compressionQuarantine: NOT_READY,
        compressionDebt: NOT_READY,
        contextComposition: NOT_READY,
        runtimeSettings: NOT_READY,
      },
    });
  });

  test("one section's failure leaves the agent in the others, and nothing to report is no failure", () => {
    const snapshot = buildHealthSnapshot(appWith([agentStub('partial', { debt: notReady, render: () => null })]));
    expect(snapshot.compressionQuarantine).toEqual({ partial: { quarantined: 1 } });
    expect(snapshot.runtimeSettings).toEqual({ partial: { contextBudgetTokens: 100_000 } });
    expect(snapshot.compressionDebt).toEqual({});
    expect(snapshot.contextComposition).toEqual({});
    expect(snapshot.readFailures).toEqual({ partial: { compressionDebt: NOT_READY } });
  });

  test('with every agent readable, each section has every agent and there are no read failures', () => {
    const snapshot = buildHealthSnapshot(appWith([agentStub('first'), agentStub('second')]));
    for (const section of ['runtimeSettings', 'compressionQuarantine', 'compressionDebt', 'contextComposition']) {
      expect(Object.keys(snapshot[section] as object)).toEqual(['first', 'second']);
    }
    expect(snapshot.readFailures).toBeUndefined();
  });

  test("a failure's message is cut to 300 characters", () => {
    const long = 'x'.repeat(1000);
    const snapshot = buildHealthSnapshot(appWith([agentStub('noisy', { debt: () => { throw new Error(long); } })]));
    expect((snapshot.readFailures as Record<string, Record<string, string>>).noisy.compressionDebt).toBe('x'.repeat(300));
  });
});
