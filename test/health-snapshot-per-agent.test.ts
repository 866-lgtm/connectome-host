/**
 * The health snapshot's per-agent sections read each agent on its own: one
 * agent whose read throws, such as one whose context manager a store surgery
 * left uninitialized, is left out, and the others are still reported.
 */
import { describe, test, expect } from 'bun:test';
import { buildHealthSnapshot, type PanelAppRef } from '../src/web/panel-data.js';

const notReady = (): never => { throw new Error('context manager is not initialized'); };

function agentStub(name: string, broken: boolean) {
  return {
    name,
    getContextManager: () => ({
      getStrategy: () => ({
        getCompressionQuarantineStatus: broken ? notReady : () => ({ quarantined: 1 }),
        getCompressionDebt: broken ? notReady : () => ({ level: 'healthy' }),
      }),
      getRenderStats: broken ? notReady : () => ({ head: 10, tail: 20 }),
    }),
  };
}

function appWith(agents: ReturnType<typeof agentStub>[]): PanelAppRef {
  const framework = {
    agents,
    healthSnapshot: () => ({ agents: agents.map((agent) => ({ name: agent.name })) }),
    getAllAgents() { return this.agents; },
    // A method, as the framework's is: it reads its own state through `this`.
    getAgentRuntimeSettings(name: string) {
      const agent = this.agents.find((a) => a.name === name);
      if (!agent || agent.name === 'broken') notReady();
      return { contextBudgetTokens: 100_000 };
    },
  };
  return { framework, recipe: {} } as unknown as PanelAppRef;
}

describe('health snapshot per agent', () => {
  test('an agent whose reads throw is left out of each per-agent section, and the others are reported', () => {
    const snapshot = buildHealthSnapshot(appWith([agentStub('broken', true), agentStub('steady', false)]));
    expect(snapshot.runtimeSettings).toEqual({ steady: { contextBudgetTokens: 100_000 } });
    expect(snapshot.compressionQuarantine).toEqual({ steady: { quarantined: 1 } });
    expect(snapshot.compressionDebt).toEqual({ steady: { level: 'healthy' } });
    expect(snapshot.contextComposition).toEqual({ steady: { head: 10, tail: 20 } });
  });

  test('with every agent readable, each section has every agent', () => {
    const snapshot = buildHealthSnapshot(appWith([agentStub('first', false), agentStub('second', false)]));
    expect(Object.keys(snapshot.runtimeSettings as object)).toEqual(['first', 'second']);
    expect(Object.keys(snapshot.compressionDebt as object)).toEqual(['first', 'second']);
  });
});
