import { describe, expect, it } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
const base = (proseRouting?: unknown) => ({ name: 'test', agent: { systemPrompt: '', ...(proseRouting === undefined ? {} : { proseRouting }) } });
describe('prose routing recipe', () => {
  it('accepts locus, explicit, hybrid, disabled, and omission', () => {
    expect(validateRecipe(base()).agent.proseRouting).toBeUndefined();
    for (const mode of ['locus', 'explicit', 'hybrid', 'disabled'] as const) expect(validateRecipe(base(mode)).agent.proseRouting).toBe(mode);
  });
  it('rejects unknown modes', () => {
    expect(() => validateRecipe(base('triple-magic'))).toThrow(/proseRouting/);
  });
});
