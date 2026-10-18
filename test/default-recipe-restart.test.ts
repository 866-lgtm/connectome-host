/**
 * A DEFAULT_RECIPE resident (kv-unified, 300k budget) that saved a lower
 * budget restarts. On agent-framework 0.22.1 the boot restore applied the
 * saved budget as a paced decrease, which kv-unified refuses
 * ("Gradual context-window transitions require ... kv-stable"), and the
 * error escaped AgentFramework.create(). 0.22.2 keeps a setting it can't
 * apply at boot instead of throwing.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { DEFAULT_RECIPE, validateRecipe } from '../src/recipe.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';

const MODEL = 'claude-opus-4-6';

async function bootDefaultRecipe(storePath: string): Promise<AgentFramework> {
  const recipe = validateRecipe(structuredClone(DEFAULT_RECIPE));
  const strategy = buildFrameworkStrategy(recipe, MODEL, 'UTC');
  return AgentFramework.create({
    storePath,
    membrane: new Membrane(new MockAdapter()),
    agents: [buildFrameworkAgentConfig(recipe, 'agent', MODEL, strategy)],
    modules: [],
  });
}

describe('DEFAULT_RECIPE restart', () => {
  test('a resident that saved a lower budget and tail boots again on the same store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'default-recipe-restart-'));
    const storePath = join(dir, 'store');
    try {
      const first = await bootDefaultRecipe(storePath);
      expect(first.getAgentRuntimeSettings('agent').contextBudgetTokens).toBe(300_000);
      first.updateAgentRuntimeSettings('agent', {
        contextBudgetTokens: 200_000,
        tailTokens: 80_000,
        immediate: true,
      });
      await first.stop();

      const second = await bootDefaultRecipe(storePath);
      try {
        // The saved settings are still the agent's, whether the boot could
        // apply the budget at once or keeps it set but unapplied.
        expect(second.getAgentRuntimeSettings('agent')).toMatchObject({
          contextBudgetTokens: 200_000,
          tailTokens: 80_000,
        });
      } finally {
        await second.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
