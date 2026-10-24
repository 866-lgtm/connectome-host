import { describe, test, expect } from 'bun:test';
import { SettingsModule } from '../src/modules/settings-module.js';
import type { ModuleContext } from '@animalabs/agent-framework';

async function started(saved: unknown, initialEnabled = true) {
  let persisted: unknown = saved;
  const writes: unknown[] = [];
  const ctx = {
    getState: () => persisted,
    setState: (s: unknown) => { persisted = JSON.parse(JSON.stringify(s)); writes.push(persisted); },
  } as unknown as ModuleContext;
  const mod = new SettingsModule('default', initialEnabled);
  await mod.start(ctx);
  return { mod, ext: mod.getAgentSettingsExtension(), persisted: () => persisted, writes };
}

describe('SettingsModule reasoning default (schema v2)', () => {
  test('fresh state follows the host default', async () => {
    expect((await started(undefined)).mod.getReasoning().enabled).toBe(true);
    expect((await started(undefined, false)).mod.getReasoning().enabled).toBe(false);
  });

  test('a default-off host keeps a pre-v2 saved choice and writes no schemaVersion', async () => {
    const on = await started({ reasoning: { enabled: true } }, false);
    expect(on.mod.getReasoning().enabled).toBe(true);
    on.ext.update('a', { reasoning_budget_tokens: 4096 });
    expect(on.persisted()).not.toHaveProperty('schemaVersion');
  });

  test('reset returns to the host default', async () => {
    const first = await started(undefined);
    first.ext.update('a', { reasoning_enabled: false });
    expect(first.ext.reset('a').reasoning_enabled).toBe(true);
  });

  test('pre-v2 saved `enabled: false` is re-defaulted on, without a write at start', async () => {
    const { mod, writes } = await started({ reasoning: { enabled: false, budgetTokens: 4096 } });
    expect(mod.getReasoning().enabled).toBe(true);
    expect(mod.getReasoning().budgetTokens).toBe(4096);
    expect(writes).toEqual([]);
  });

  test('a v2 choice to disable survives restarts', async () => {
    const first = await started(undefined);
    first.ext.update('a', { reasoning_enabled: false });
    expect(first.persisted()).toMatchObject({ schemaVersion: 2, reasoning: { enabled: false } });
    const second = await started(first.persisted());
    expect(second.mod.getReasoning().enabled).toBe(false);
  });
});
