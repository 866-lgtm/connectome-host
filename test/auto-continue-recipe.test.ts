import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const base = (value?: unknown) => ({
  name: 'auto-continue',
  agent: {
    systemPrompt: 'sys',
    ...(value === undefined ? {} : { autoContinue: value }),
  },
});

const built = (value?: unknown) =>
  (buildFrameworkAgentConfig(validateRecipe(base(value)), 'a', 'm', { kind: 's' } as never) as { autoContinue?: unknown }).autoContinue;

describe('autoContinue recipe wiring', () => {
  test('is off by omission and passes true, false and a cap through to AgentConfig', () => {
    expect(built()).toBeUndefined();
    expect(built(true)).toBe(true);
    expect(built(false)).toBe(false);
    expect(built({})).toEqual({});
    expect(built({ maxConsecutive: 5 })).toEqual({ maxConsecutive: 5 });
    const reloaded = validateRecipe(JSON.parse(JSON.stringify(validateRecipe(base({ maxConsecutive: 2 })))));
    expect((buildFrameworkAgentConfig(reloaded, 'b', 'm', { kind: 's' } as never) as { autoContinue?: unknown }).autoContinue)
      .toEqual({ maxConsecutive: 2 });
  });

  test('refuses anything else at load, rather than at boot or silently', () => {
    for (const value of ['true', 1, null, [], { maxConsecutive: 0 }, { maxConsecutive: 21 }, { maxConsecutive: 1.5 }, { maxConsecutive: '3' }]) {
      expect(() => validateRecipe(base(value))).toThrow(/agent\.autoContinue/);
    }
    expect(() => validateRecipe(base({ maxConsecutve: 3 }))).toThrow(/unknown key "maxConsecutve"; it takes maxConsecutive/);
  });
});
