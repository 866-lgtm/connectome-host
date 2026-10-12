/**
 * GET /debug/context?media=0 collapses inlined base64 image payloads to size
 * placeholders server-side. With a few Discord images in the window the full
 * response runs to several MB, which stalls the Web UI's fetch over an SSH
 * tunnel; ContextDocument and the /prompt inspector always ask for media=0.
 * Without the param the response keeps full fidelity.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  stripBase64Media,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';

const BIG_B64 = 'iVBORw0KGgo' + 'A'.repeat(300 * 1024);
const LONG_PROSE = 'not base64, just a long tool output. '.repeat(200);

const request = {
  system: 'sys',
  messages: [
    {
      participant: 'helen',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { type: 'base64', data: BIG_B64, mediaType: 'image/png' } },
        { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgoAAAA=', mediaType: 'image/png' } },
      ],
    },
    {
      participant: 'Polaris',
      content: [
        {
          type: 'tool_result',
          toolUseId: 't1',
          content: [
            { type: 'text', text: LONG_PROSE },
            { type: 'image', source: { type: 'base64', data: BIG_B64, mediaType: 'image/jpeg' } },
          ],
        },
        { type: 'text', text: `data:image/png;base64,${BIG_B64}` },
      ],
    },
  ],
};

let webUiModule: WebUiModule;
let port: number;

beforeAll(async () => {
  webUiModule = new WebUiModule({ port: 0, host: '127.0.0.1' });
  await webUiModule.start({} as ModuleContext);
  port = __getSharedServerPortForTests() ?? 0;
  if (!port) throw new Error('webui server not bound');
  webUiModule.setApp({
    framework: {
      getAllAgents: () => [],
      getAllModules: () => [],
      getAgent: (name: string) => (name === 'Polaris' ? { name } : undefined),
      previewActivation: async () => structuredClone(request),
      onTrace: () => {},
    },
    sessionManager: { getActiveSession: () => ({ id: 's', name: 's', manuallyNamed: true }) },
    recipe: { name: 'recipe', agent: { name: 'Polaris' } },
  } as never);
});

afterAll(async () => {
  await webUiModule.stop();
  await __resetSharedServerForTests();
});

describe('/debug/context?media=0', () => {
  test('strips large base64 payloads to size placeholders, keeping everything else', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/debug/context?media=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const raw = await res.text();
    expect(raw.length).toBeLessThan(20_000);
    expect(raw).not.toContain('A'.repeat(4096));

    const body = JSON.parse(raw) as { agent: string; request: typeof request };
    expect(body.agent).toBe('Polaris');
    const [user, assistant] = body.request.messages;
    const big = user!.content[1] as { source: { data: string; mediaType: string } };
    expect(big.source.data).toBe('[base64 stripped 300kb]');
    expect(big.source.mediaType).toBe('image/png');
    // Small payloads (<= 2 KiB) survive, so tiny images still render.
    expect((user!.content[2] as { source: { data: string } }).source.data).toBe('iVBORw0KGgoAAAA=');

    const toolResult = assistant!.content[0] as { content: Array<{ text?: string; source?: { data: string } }> };
    // Long prose is not base64 and passes through untouched.
    expect(toolResult.content[0]!.text).toBe(LONG_PROSE);
    expect(toolResult.content[1]!.source!.data).toBe('[base64 stripped 300kb]');
    // data: URLs keep their media-type prefix.
    expect((assistant!.content[1] as { text: string }).text).toBe('data:image/png;base64,[stripped 300kb]');
  });

  test('without media=0 the response keeps full fidelity', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/debug/context`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request: typeof request };
    expect(body.request).toEqual(request);
  });

  test('pretty=1 composes with media=0', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/debug/context?media=0&pretty=1`);
    const raw = await res.text();
    expect(raw).toContain('\n  "agent": "Polaris"');
    expect(raw).toContain('[base64 stripped 300kb]');
  });
});

describe('stripBase64Media', () => {
  test('leaves non-strings, short strings and non-base64 long strings alone', () => {
    expect(stripBase64Media('k', 42)).toBe(42);
    expect(stripBase64Media('k', 'abc')).toBe('abc');
    expect(stripBase64Media('k', LONG_PROSE)).toBe(LONG_PROSE);
    expect(stripBase64Media('k', null)).toBe(null);
  });
});
