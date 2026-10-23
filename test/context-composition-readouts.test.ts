/**
 * The context composition readouts where an agent has no composition
 * (connectome-host#425), and the Health view's last-inference line.
 * context-manager gives an agent's render stats only from a live compile
 * since its context was loaded, and only for a strategy that keeps them, so
 * the views say which of the two it is. agent-framework keeps an agent's
 * last inference start, end and failure each until the next of its kind, so
 * the last-inference line names a failure only when it came at or after the
 * latest start.
 *
 * web/src/composition-text.ts is imported inside each test, so that run
 * against main's sources, where it doesn't exist, each test fails on its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { buildContextMakeup, buildHealthSnapshot, type PanelAppRef } from '../src/web/panel-data.js';

const words = () => import('../web/src/composition-text');

describe('the line where an agent has no composition', () => {
  test("it says no live compile since the context was loaded, or that the agent's strategy keeps none", async () => {
    const { noComposition } = await words();
    expect(noComposition(true)).toBe('No live compile since its context was loaded.');
    expect(noComposition(false)).toBe("This agent's strategy keeps no composition.");
  });

  test("the Health view shows an entry's stats, else the line for an agent left out or kept out, and nothing where the section or the agent's read failed", async () => {
    const { healthComposition } = await words();
    const read = { sectionRead: true, readFailed: false };
    const stats = { head: { messages: 2, tokens: 10 } };
    expect(healthComposition(stats, read)).toEqual({ stats });
    expect(healthComposition(undefined, read)).toEqual({ line: 'No live compile since its context was loaded.' });
    expect(healthComposition({ statsKept: false as const }, read)).toEqual({ line: "This agent's strategy keeps no composition." });
    expect(healthComposition(undefined, { sectionRead: true, readFailed: true })).toBeNull();
    expect(healthComposition(undefined, { sectionRead: false, readFailed: false })).toBeNull();
  });
});

describe("the Health view's last-inference line", () => {
  test('a failure then a later success reads as ended', async () => {
    const { lastInferenceState } = await words();
    expect(lastInferenceState({ failedAt: 105, startedAt: 200, endedAt: 260 })).toEqual({ word: 'ended', at: 260 });
  });

  test('a success then a later failure reads as failed', async () => {
    const { lastInferenceState } = await words();
    // A failed inference may have an end too, before or after its failure.
    expect(lastInferenceState({ startedAt: 200, failedAt: 230, endedAt: 231 })).toEqual({ word: 'failed', at: 230 });
    expect(lastInferenceState({ startedAt: 200, endedAt: 229, failedAt: 230 })).toEqual({ word: 'failed', at: 230 });
  });

  test('a failure then a start still running reads as started', async () => {
    const { lastInferenceState } = await words();
    expect(lastInferenceState({ startedAt: 200, failedAt: 105, endedAt: 106 })).toEqual({ word: 'started', at: 200 });
    expect(lastInferenceState({ startedAt: 200 })).toEqual({ word: 'started', at: 200 });
  });

  test("a failure or an end in the latest start's millisecond reads as that inference's", async () => {
    const { lastInferenceState } = await words();
    // A failure before any request can land in its own start's millisecond.
    expect(lastInferenceState({ startedAt: 200, failedAt: 200 })).toEqual({ word: 'failed', at: 200 });
    expect(lastInferenceState({ startedAt: 200, failedAt: 200, endedAt: 200 })).toEqual({ word: 'failed', at: 200 });
    expect(lastInferenceState({ startedAt: 200, endedAt: 200 })).toEqual({ word: 'ended', at: 200 });
  });

  test('the line says the word and how long ago, from the time the word is about', async () => {
    const { lastInferenceLine } = await words();
    const ago = (at: number) => `${300 - at}ms ago`;
    expect(lastInferenceLine({ failedAt: 105, startedAt: 200, endedAt: 260 }, ago)).toBe('last inference: ended 40ms ago');
    expect(lastInferenceLine({ startedAt: 200, failedAt: 230 }, ago)).toBe('last inference: failed 70ms ago');
    expect(lastInferenceLine({ startedAt: 200 }, ago)).toBe('last inference: started 100ms ago');
    expect(lastInferenceLine(null, ago)).toBeNull();
  });

  test('a failure with no start is failed, and nothing reported is no line', async () => {
    const { lastInferenceState } = await words();
    expect(lastInferenceState({ failedAt: 105 })).toEqual({ word: 'failed', at: 105 });
    expect(lastInferenceState({})).toBeNull();
    expect(lastInferenceState(null)).toBeNull();
    expect(lastInferenceState(undefined)).toBeNull();
  });
});

describe("why the Context page's next request wasn't counted", () => {
  test('each countSource the makeup endpoint gives has its reason', async () => {
    const { notCounted } = await words();
    expect(notCounted('count_tokens_unsupported_model')).toBe("not counted: count_tokens doesn't take this agent's model");
    expect(notCounted('count_tokens_failed_429')).toBe('not counted: count_tokens answered 429');
    expect(notCounted('count_tokens_error')).toBe('not counted: the count_tokens call failed');
    expect(notCounted('count_tokens')).toBe('not counted: count_tokens answered with no count');
    expect(notCounted('something_new')).toBe('not counted (something_new)');
  });
});

/** A context manager whose strategy keeps render stats, or one that, like
 *  PassthroughStrategy, has no getRenderStats. */
function cmWith(stats: unknown, statsKept: boolean) {
  return {
    getRenderStats: () => stats,
    getStrategy: () => (statsKept ? { getRenderStats: () => stats } : {}),
  };
}

describe('the makeup endpoint', () => {
  const priorModel = process.env.COUNT_TOKENS_MODEL;
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    // The Claude-model path counts through a fetch stub; the other path is
    // a model count_tokens doesn't take.
    globalThis.fetch = (async () => new Response(JSON.stringify({ input_tokens: 4_242 }), { status: 200 })) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    if (priorModel === undefined) delete process.env.COUNT_TOKENS_MODEL;
    else process.env.COUNT_TOKENS_MODEL = priorModel;
  });

  function appWith(cm: ReturnType<typeof cmWith>, model: string) {
    return {
      recipe: { agent: { name: 'agent' } },
      framework: {
        getAgent: () => ({ model, getContextManager: () => cm }),
        previewActivation: async () => ({ messages: [{ participant: 'Lari', content: [{ type: 'text', text: 'hi' }] }] }),
      },
    } as unknown as PanelAppRef;
  }

  for (const [path, model, count] of [
    ['a model count_tokens takes', 'claude-haiku-4-5', 4_242],
    ["a model count_tokens doesn't take", 'gpt-6', null],
  ] as const) {
    test(`with ${path}, it tells a strategy that keeps no render stats from one with none yet, and gives the stats after a compile`, async () => {
      if (count === null) delete process.env.COUNT_TOKENS_MODEL;
      else process.env.COUNT_TOKENS_MODEL = model;
      const none = await buildContextMakeup(appWith(cmWith(null, true), model), 'agent');
      expect(none.stats).toBeNull();
      expect(none.statsKept).toBe(true);
      expect(none.exactTotalTokens).toBe(count);
      const passthrough = await buildContextMakeup(appWith(cmWith(null, false), model), 'agent');
      expect(passthrough.stats).toBeNull();
      expect(passthrough.statsKept).toBe(false);
      const stats = { total: { messages: 160, tokens: 16_690 } };
      const compiled = await buildContextMakeup(appWith(cmWith(stats, true), model), 'agent');
      expect(compiled.stats).toBe(stats);
      expect(compiled.statsKept).toBe(true);
    });
  }
});

describe("the health snapshot's contextComposition", () => {
  test('an agent with stats has them, one with none yet is left out, and one whose strategy keeps none has statsKept false', () => {
    const stats = { head: 10, tail: 20 };
    const agents = [
      { name: 'compiled', getContextManager: () => cmWith(stats, true) },
      { name: 'waiting', getContextManager: () => cmWith(null, true) },
      { name: 'passthrough', getContextManager: () => cmWith(null, false) },
    ];
    const app = {
      recipe: {},
      framework: {
        agents,
        healthSnapshot: () => ({ agents: agents.map((a) => ({ name: a.name })) }),
        getAllAgents() { return this.agents; },
      },
    } as unknown as PanelAppRef;
    const snapshot = buildHealthSnapshot(app);
    expect(snapshot.contextComposition).toEqual({ compiled: stats, passthrough: { statsKept: false } });
    expect(snapshot.readFailures).toBeUndefined();
  });
});
