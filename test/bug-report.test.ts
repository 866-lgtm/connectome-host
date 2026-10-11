/**
 * `/bug`: a report for connectome-host's public issues that can't carry
 * conversation text. The guarantee is checked by canaries: one in every
 * source of text a session writes and in every field a user can set. None
 * may reach the report, its title, its link, the command's output or the
 * file it saves.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentFramework } from '@animalabs/agent-framework';

import {
  BUG_REPORT_MARKER,
  BUG_REPORT_URL_CAP,
  HOST_LOG_TAGS,
  buildBugReport,
  bugReportUrl,
  currentSession,
  gatherBugReportFacts,
  parseErrorLog,
  publicModelId,
  runtimeMode,
  serverRows,
  summarizeProviderCalls,
  type BugReportFacts,
} from '../src/bug-report.js';
import { createBranchState, handleCommand } from '../src/commands.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-11T23:50:00.000Z');
/** Spelled so no casing of the report's own words can contain it. */
const CANARY = 'zqxcanaryzqx';
/** A data directory under the checkout, as DATA_DIR's default puts it. */
const SESSION_FILE_DIR = join(ROOT, `data-bug-probe-${process.pid}`, 'workspace');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'bug-report-'));
}

/** A data directory holding a canary in every source of text. */
function canaryDataDir(): string {
  const dir = scratch();
  mkdirSync(SESSION_FILE_DIR, { recursive: true });
  writeFileSync(join(SESSION_FILE_DIR, `${CANARY}-scene.js`), '// written by a session\n');
  const call = (fields: Record<string, unknown>) => JSON.stringify({
    kind: 'stream', timestamp: '2026-10-11T23:40:00.000Z', durationMs: 900,
    rawRequest: { system: `system ${CANARY}`, messages: [{ role: 'user', content: `hi ${CANARY}` }] },
    response: { content: [{ type: 'text', text: `reply ${CANARY}` }] },
    ...fields,
  });
  writeFileSync(join(dir, 'llm-calls.2026-10-11T23-00-00-000Z.jsonl'), [
    call({ type: 'call' }),
    call({
      type: 'error', provider: 'anthropic', httpStatus: 529, errorType: 'server', retryable: true,
      providerErrorCode: 'overloaded_error', error: `Overloaded while answering "${CANARY}"`,
    }),
    call({
      type: 'error', provider: CANARY, httpStatus: 400, errorType: CANARY, retryable: false,
      providerErrorCode: `${CANARY}_code`, error: `echo of the request: ${CANARY}`,
      timestamp: '2026-10-11T23:45:00.000Z',
    }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'tui-error.log'), [
    '--- session 2026-10-11T22:00:00.000Z ---',
    `[mcpl] an earlier session's line ${CANARY}`,
    '--- session 2026-10-11T23:00:00.000Z ---',
    `[mcpl] server "srv" handler failed: ${CANARY}`,
    `[mcpl] another ${CANARY}`,
    `[routing] speech for ${CANARY}`,
    `[${CANARY}] a server's own stderr line`,
    `TypeError: cannot read ${CANARY} of undefined`,
    `    at handleBug (${join(ROOT, 'src/commands.ts')}:12:3)`,
    `    at ${CANARY}Fn (/home/${CANARY}/project/src/thing.ts:1:1)`,
    `    at processTicksAndRejections (node:internal/process/task_queues:105:5)`,
    `Zqxcanaryzqx${'Error'}: a class name the user's code made up`,
    `    at handleBug (${join(ROOT, 'src/commands.ts')}:40:9)`,
    `    at forged (${join(ROOT, `src/${CANARY}.ts`)}:1:1)`,
    // A file a session wrote under the checkout's data directory, with a
    // name from the conversation: it exists, but isn't our code.
    'ReferenceError: x is not defined',
    `    at run (${join(SESSION_FILE_DIR, `${CANARY}-scene.js`)}:3:1)`,
    `a quoted message: "${CANARY}"`,
  ].join('\n') + '\n');
  return dir;
}

/** A recipe with a canary in every field a user can set. */
function canaryRecipe(model = `${CANARY}-finetune`) {
  return {
    name: `${CANARY} recipe`,
    description: `${CANARY} description`,
    agent: {
      name: `${CANARY}-agent`,
      provider: 'openai-compatible',
      model,
      baseUrl: `https://${CANARY}.example/v1`,
      systemPrompt: `You are ${CANARY}.`,
      maxTokens: 8192,
      contextBudgetTokens: 150000,
      cacheTtl: '1h',
      proseRouting: 'locus',
      thinking: { enabled: true },
    },
    modules: { subagents: true, wake: true, lessons: false, [`${CANARY}Module`]: true },
    extensions: { [`${CANARY}Ext`]: { path: `/home/${CANARY}/ext.js` } },
    mcpServers: {
      [`${CANARY}-server`]: { command: `/home/${CANARY}/bin/server`, args: [CANARY], env: { TOKEN: CANARY } },
      discord: { command: 'node', args: ['x'], source: { npm: '@animalabs/discord-mcpl@1.2.3' } },
      other: { command: 'npx', args: [`${CANARY}-mcp`], source: { npm: `${CANARY}-mcp@1.0.0` } },
      remote: { url: `wss://${CANARY}.example/mcpl?token=${CANARY}`, token: CANARY },
    },
  };
}

const LIVE = [
  { id: `${CANARY}-server`, connected: true, toolCount: 4 },
  { id: 'discord', connected: false, retrying: true, toolCount: 0 },
  { id: 'other', connected: true, toolCount: 2 },
  { id: 'remote', connected: false, refused: `MCP server "remote": url wss://${CANARY}.example/mcpl does not match transport "stdio"`, toolCount: 0 },
];

function canaryFacts(dir: string, mode: 'tui' | 'headless' = 'tui'): BugReportFacts {
  const recipe = canaryRecipe();
  return gatherBugReportFacts({
    now: NOW,
    mode,
    dataDir: dir,
    recipe,
    liveServers: LIVE,
    serverConfig: (id) => (recipe.mcpServers as Record<string, never>)[id],
  });
}

afterAll(() => rmSync(dirname(SESSION_FILE_DIR), { recursive: true, force: true }));

function expectNoCanary(text: string, where: string): void {
  expect(text.toLowerCase().includes(CANARY), `${where} carries the canary:\n${text}`).toBe(false);
}

describe('the guarantee', () => {
  test('no text a session wrote, and no field a user set, reaches the report or its link', () => {
    const dir = canaryDataDir();
    try {
      const facts = canaryFacts(dir);
      const { full, linked, url } = buildBugReport('The agent stopped answering after I switched sessions.', facts);
      for (const [where, text] of [
        ['title', full.title], ['report', full.report], ['linked report', linked.report],
        ['url', url], ['decoded url', decodeURIComponent(url.replace(/\+/g, ' '))],
      ] as const) {
        expectNoCanary(text, where);
      }
      // What the shapes do say, from the same sources.
      expect(full.report).toContain('provider: openai-compatible · model: custom');
      expect(full.report).toContain('modules: subagents, wake · custom: 2');
      expect(full.report).toContain('server 1: a local command · stdio · legacy · connected · 4 tools');
      expect(full.report).toContain('server 2: @animalabs/discord-mcpl@1.2.3 · stdio · legacy · retrying · 0 tools');
      expect(full.report).toContain('server 3: a registry package · stdio · legacy · connected · 2 tools');
      expect(full.report).toContain('server 4: a url server · websocket · legacy · refused · 0 tools');
      expect(full.report).toContain('Provider calls, last hour: 3, 2 failed');
      expect(full.report).toContain('2026-10-11T23:40:00Z stream anthropic 529 server retryable overloaded_error');
      expect(full.report).toContain('2026-10-11T23:45:00Z stream ? 400 ? not retryable other');
      expect(full.report).toContain('tags: mcpl 2, routing 1, other 1');
      expect(full.report).toContain('TypeError ×1');
      expect(full.report).toContain('connectome-host/src/commands.ts:12');
      expect(full.report).toContain('another error class ×1');
      expect(full.report).toContain('connectome-host/src/commands.ts:40');
      // The session's file is no frame: the error is named, with no location.
      expect(full.report).toMatch(/ReferenceError ×1 · sig [0-9a-f]{8}\n\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the command's output and the file it saves carry none of it either", () => {
    const dir = canaryDataDir();
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    try {
      const recipe = canaryRecipe();
      const app = {
        framework: { listMcplServers: () => LIVE } as unknown as AgentFramework,
        sessionManager: {} as never,
        recipe: recipe as never,
        branchState: createBranchState(),
        switchSession: async () => {},
      };
      const result = handleCommand('/bug  It froze when the Discord server reconnected.', app);
      const output = result.lines.map((line) => line.text).join('\n');
      expectNoCanary(output.replace(dir, '<dir>'), 'the command output');
      expect(output).toContain('nothing has been sent');
      expect(output).toContain('  It froze when the Discord server reconnected.');
      expect(output).toContain('https://github.com/anima-research/connectome-host/issues/new?template=bug_report.yml');
      const saved = readdirSync(dir).filter((name) => name.startsWith('bug-report-'));
      expect(saved.length).toBe(1);
      expectNoCanary(readFileSync(join(dir, saved[0]!), 'utf8'), 'the saved file');
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a model id goes in only when every word of it is a public model word, a number or a date', () => {
    expect(publicModelId('anthropic', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(publicModelId('anthropic', 'claude-3-5-sonnet-20240620')).toBe('claude-3-5-sonnet-20240620');
    expect(publicModelId('bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(publicModelId('openai-responses', 'gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(publicModelId('openai-codex', 'o3')).toBe('o3');
    expect(publicModelId('openrouter', 'anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
    expect(publicModelId('openrouter', 'meta-llama/llama-3.1-70b-instruct')).toBe('meta-llama/llama-3.1-70b-instruct');
    // A user's words after a public-looking prefix, or an unknown vendor.
    expect(publicModelId('anthropic', `claude-${CANARY}`)).toBe('custom');
    expect(publicModelId('bedrock', `anthropic.claude-${CANARY}`)).toBe('custom');
    expect(publicModelId('openai-responses', `gpt-${CANARY}`)).toBe('custom');
    expect(publicModelId('openrouter', `${CANARY}/secret-model`)).toBe('custom');
    expect(publicModelId('openrouter', `openai/${CANARY}`)).toBe('openai/custom');
    expect(publicModelId('bedrock', 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/x')).toBe('custom');
    expect(publicModelId('openai-compatible', 'claude-sonnet-4-5')).toBe('custom');
    expect(publicModelId('anthropic', undefined)).toBe(null);
  });

  test('versions and the OS release keep their numeric core only', () => {
    const root = scratch();
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: `0.9.0-${CANARY}` }));
      const facts = gatherBugReportFacts({ now: NOW, mode: 'batch', dataDir: root, recipe: {}, liveServers: [], serverConfig: () => undefined, root });
      expect(facts.host.version).toBe('0.9.0');
      expect(facts.runtime.release === null || /^\d+(\.\d+)+$/.test(facts.runtime.release)).toBe(true);
      expectNoCanary(buildBugReport('x', facts).full.report, 'the report');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the shapes', () => {
  test('the error log is read from its current session only, as tags and error shapes', () => {
    const exists = () => true;
    const session = currentSession([
      '--- session 2026-10-11T22:00:00.000Z ---',
      '[mcpl] old',
      '--- session 2026-10-11T23:00:00.000Z ---',
      '[2026-10-11T23:00:01.000Z] [shutdown] stopping',
      '[MCPL] upper-case tag',
      '[weird tag with spaces] not a tag',
      'RangeError: out of range',
      `    at a (${join(ROOT, 'src/a.ts')}:1:1)`,
      `    at b (${join(ROOT, 'src/b.ts')}:2:1)`,
      `    at c (${join(ROOT, 'src/c.ts')}:3:1)`,
      `    at d (${join(ROOT, 'src/d.ts')}:4:1)`,
      'RangeError: out of range again',
      `    at a (${join(ROOT, 'src/a.ts')}:1:1)`,
      `    at b (${join(ROOT, 'src/b.ts')}:2:1)`,
      `    at c (${join(ROOT, 'src/c.ts')}:3:1)`,
      'error: Bun prints uncaught errors this way',
      `    at e (file://${join(ROOT, 'src/e.ts')}:5:1)`,
      `    at f (${join(ROOT, 'node_modules/@animalabs/agent-framework/dist/src/framework.js')}:9:1)`,
    ].join('\n'));
    expect(session.includes('old')).toBe(false);
    const parsed = parseErrorLog(session, ROOT, exists);
    expect([...parsed.tags.entries()]).toEqual([['shutdown', 1], ['mcpl', 1]]);
    expect(parsed.otherTags).toBe(0);
    expect(parsed.errors.map((e) => [e.className, e.count, e.frames])).toEqual([
      ['RangeError', 2, ['connectome-host/src/a.ts:1', 'connectome-host/src/b.ts:2', 'connectome-host/src/c.ts:3']],
      ['Error', 1, ['connectome-host/src/e.ts:5', '@animalabs/agent-framework/dist/src/framework.js:9']],
    ]);
    expect(parsed.errors[0]!.signature).toMatch(/^[0-9a-f]{8}$/);
    // The same shape gives the same signature: a repeat is one search away.
    expect(parseErrorLog(session, ROOT, exists).errors[0]!.signature).toBe(parsed.errors[0]!.signature);
  });

  test('a frame names our code only, and only a file that exists', () => {
    const parsed = parseErrorLog([
      'TypeError: x',
      `    at a (${join(ROOT, 'src/commands.ts')}:3:1)`,
      `    at b (${join(ROOT, 'src/not-a-real-file.ts')}:3:1)`,
      `    at c (/elsewhere/project/src/commands.ts:3:1)`,
      `    at d (${join(ROOT, 'node_modules/left-pad/index.js')}:3:1)`,
    ].join('\n'), ROOT, (file) => readdirSync(dirname(file)).includes(file.split('/').pop()!));
    expect(parsed.errors[0]!.frames).toEqual(['connectome-host/src/commands.ts:3']);
  });

  test('provider calls: the last hour, by classification only', () => {
    const line = (t: string, fields: Record<string, unknown>) => JSON.stringify({ timestamp: t, kind: 'complete', ...fields });
    const summary = summarizeProviderCalls([
      line('2026-10-11T22:40:00.000Z', { type: 'error', httpStatus: 500 }),
      line('2026-10-11T23:10:00.000Z', { type: 'call' }),
      line('2026-10-11T23:20:00.000Z', { type: 'error', provider: 'bedrock', httpStatus: 429, errorType: 'rate_limit', retryable: true, providerErrorCode: 'ThrottlingException' }),
      line('2026-10-11T23:30:00.000Z', { type: 'error', httpStatus: 9999, errorType: 'made-up', providerErrorCode: 'whatever the provider said' }),
      'not json',
      JSON.stringify({ type: 'error', timestamp: 'yesterday' }),
    ], NOW);
    expect(summary.calls).toBe(3);
    expect(summary.failed).toBe(2);
    expect(summary.recent).toEqual([
      { at: '2026-10-11T23:30:00Z', kind: 'complete', provider: null, status: null, type: null, retryable: null, code: 'other' },
      { at: '2026-10-11T23:20:00Z', kind: 'complete', provider: 'bedrock', status: 429, type: 'rate_limit', retryable: true, code: 'ThrottlingException' },
    ]);
  });

  test("the framework's own family and transport come first; with no configuration, the live entry's command or url by presence", () => {
    const rows = serverRows(
      [
        { id: 'h', family: 'modern', transport: 'http', url: `https://${CANARY}.example/mcp`, connected: true, toolCount: 1 },
        { id: 'deployed', command: `/home/${CANARY}/bin/x`, connected: true, toolCount: 2 },
        { id: 'odd', family: CANARY, transport: CANARY },
      ],
      (id) => (id === 'h' ? { url: `https://${CANARY}.example/mcp` } : undefined),
    );
    expect(rows).toEqual([
      { kind: 'a url server', transport: 'http', family: 'modern', connected: true, retrying: false, refused: false, toolCount: 1 },
      { kind: 'a local command', transport: 'stdio', family: 'legacy', connected: true, retrying: false, refused: false, toolCount: 2 },
      { kind: 'unknown', transport: 'unknown', family: 'legacy', connected: false, retrying: false, refused: false, toolCount: 0 },
    ]);
    expectNoCanary(JSON.stringify(rows), 'the rows');
  });

  test('servers are rows by ordinal, and only our own packages are named', () => {
    const rows = serverRows(
      [{ id: 'a', connected: true, toolCount: 3 }, { id: 'b' }, { id: 'c', refused: 'a sentence' }],
      (id) => ({
        a: { source: { npm: '@animalabs/heartbeat-mcpl@0.2.0' }, command: 'node' },
        b: { url: 'ws://localhost:1234/x' },
        c: { url: 'http://h/x', transport: 'stdio', command: 'x' },
      } as Record<string, object>)[id],
    );
    expect(rows).toEqual([
      { kind: '@animalabs/heartbeat-mcpl@0.2.0', transport: 'stdio', family: 'legacy', connected: true, retrying: false, refused: false, toolCount: 3 },
      { kind: 'a url server', transport: 'websocket', family: 'legacy', connected: false, retrying: false, refused: false, toolCount: 0 },
      { kind: 'a url server', transport: 'stdio', family: 'legacy', connected: false, retrying: false, refused: true, toolCount: 0 },
    ]);
  });

  test("every tag connectome-host's own code begins a log line with is a named tag", () => {
    const src = join(ROOT, 'src');
    const tags = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          for (const match of readFileSync(path, 'utf8').matchAll(/console\.(?:error|warn|log)\(\s*[`'"]\[([a-z0-9:_-]{1,40})\]/gi)) {
            tags.add(match[1]!.toLowerCase());
          }
        }
      }
    };
    walk(src);
    const missing = [...tags].filter((tag) => !HOST_LOG_TAGS.has(tag));
    expect(missing).toEqual([]);
  });
});

describe('the link', () => {
  test("fills the form's two fields by id, names the form, and never asks for labels", () => {
    const dir = canaryDataDir();
    try {
      const { url } = buildBugReport('It crashed.', canaryFacts(dir));
      const params = new URL(url).searchParams;
      expect([...params.keys()]).toEqual(['template', 'title', 'what', 'report']);
      expect(params.get('template')).toBe('bug_report.yml');
      expect(params.get('title')).toBe('[/bug] It crashed.');
      expect(params.get('report')!.startsWith(BUG_REPORT_MARKER)).toBe(true);
      const form = readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8');
      expect(form).toContain('id: what');
      expect(form).toContain('id: report');
      expect(form).toContain('labels: ["bug"]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stays within its cap: the lists collapse first, then the text is cut, each saying so', () => {
    const dir = canaryDataDir();
    try {
      const facts = canaryFacts(dir);
      const long = `${'A long account of what happened. '.repeat(400)}`;
      const { full, linked, url, cut } = buildBugReport(long, facts);
      expect(url.length).toBeLessThanOrEqual(BUG_REPORT_URL_CAP);
      expect(cut).toEqual(['the failure list and error frames', 'part of "What happened"']);
      expect(linked.what).toMatch(/\[\d+ characters cut to fit the link; the whole text is in the report file\]$/);
      expect(full.what).toBe(long);
      expect(bugReportUrl(full).length).toBeGreaterThan(BUG_REPORT_URL_CAP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a title is the first line, cut at 80 characters', () => {
    const dir = canaryDataDir();
    try {
      const { full } = buildBugReport(`\n${'x'.repeat(120)}\nsecond line`, canaryFacts(dir));
      expect([...full.title].length).toBe('[/bug] '.length + 80);
      expect(full.title.endsWith('…')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the mode', () => {
  test("follows index.ts's rule", () => {
    expect(runtimeMode(['bun', 'src/index.ts', '--headless'], false)).toBe('headless');
    expect(runtimeMode(['bun', 'src/index.ts'], false)).toBe('batch');
    expect(runtimeMode(['bun', 'src/index.ts', '--no-tui'], true)).toBe('readline');
    expect(runtimeMode(['bun', 'src/index.ts'], true)).toBe('tui');
  });

  test('headless reads headless.log; readline and batch have no error log', () => {
    const dir = canaryDataDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'headless.log'), '\n--- session 2026-10-11T23:30:00.000Z ---\n[mcpl] x\n');
      const headless = gatherBugReportFacts({ now: NOW, mode: 'headless', dataDir: dir, recipe: {}, liveServers: [], serverConfig: () => undefined });
      expect(headless.hostErrors?.log).toBe('headless.log');
      expect(headless.hostErrors?.tags).toEqual([['mcpl', 1]]);
      const batch = gatherBugReportFacts({ now: NOW, mode: 'batch', dataDir: dir, recipe: {}, liveServers: [], serverConfig: () => undefined });
      expect(batch.hostErrors).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
