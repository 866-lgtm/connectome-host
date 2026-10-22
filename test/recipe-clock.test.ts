import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const base = (value?: unknown) => ({
  name: 'clock',
  agent: {
    systemPrompt: 'sys',
    ...(value === undefined ? {} : { clock: value }),
  },
});

describe('clock recipe wiring', () => {
  test('is off by omission and passes a clock through to AgentConfig unchanged', () => {
    const absent = validateRecipe(base());
    expect(absent.agent.clock).toBeUndefined();
    expect(buildFrameworkAgentConfig(absent, 'a', 'm', { kind: 's' } as never).clock).toBeUndefined();

    const minutes = validateRecipe(base({ intervalMinutes: 10 }));
    expect(buildFrameworkAgentConfig(minutes, 'a', 'm', { kind: 's' } as never).clock).toEqual({ intervalMinutes: 10 });

    const seconds = validateRecipe(base({ intervalSeconds: 15, precision: 'seconds' }));
    expect(buildFrameworkAgentConfig(seconds, 'a', 'm', { kind: 's' } as never).clock)
      .toEqual({ intervalSeconds: 15, precision: 'seconds' });

    const reloaded = validateRecipe(JSON.parse(JSON.stringify(minutes)));
    expect(buildFrameworkAgentConfig(reloaded, 'c', 'm', { kind: 's' } as never).clock).toEqual({ intervalMinutes: 10 });
  });

  test('refuses a clock the framework would refuse at boot, at recipe validation', () => {
    expect(() => validateRecipe(base(10))).toThrow(/Recipe agent\.clock must be an object/);
    expect(() => validateRecipe(base(null))).toThrow(/Recipe agent\.clock must be an object/);
    expect(() => validateRecipe(base({ interval: 10 }))).toThrow(/unknown key "interval"/);
    expect(() => validateRecipe(base({}))).toThrow(/Recipe agent\.clock takes exactly one of intervalMinutes and intervalSeconds/);
    expect(() => validateRecipe(base({ intervalMinutes: 0 }))).toThrow(/Recipe agent\.clock\.intervalMinutes must be a positive whole number/);
    expect(() => validateRecipe(base({ intervalMinutes: 2000 }))).toThrow(/at most a day/);
    expect(() => validateRecipe(base({ intervalSeconds: 90, precision: 'minutes' }))).toThrow(/precision 'seconds'/);
  });
});
