/**
 * McplAdminModule — agent-facing deploy/restart/unload tools, exercised
 * against a stub framework. Overlay persistence is verified on disk.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFUSAL_REACTION_BASELINE } from '@animalabs/agent-framework';
import type { AgentFramework } from '@animalabs/agent-framework';

import { McplAdminModule } from '../src/modules/mcpl-admin-module.js';
import { readAgentOverlay, saveAgentOverlay } from '../src/mcpl-config.js';

interface StubServer {
  id: string;
  connected: boolean;
  retrying: boolean;
  toolPrefix: string;
  toolCount: number;
  policyEstablished: boolean;
  effectiveGrant: string[];
  maskedCapabilities: string[];
  deniedCapabilities: string[];
  allowHostCommands: boolean;
  manifestState?: {
    lastValidatedRevision: string | null;
    lastFetchedAt: number | null;
    lastNegotiatedAt: number | null;
  };
  toolClasses?: Array<{ tool: string; serverTool: string; class: string[]; source: string }>;
  command?: string;
  url?: string;
}

function makeStubFramework() {
  const servers = new Map<string, StubServer>();
  const calls: string[] = [];
  const stub = {
    listMcplServers: () => [...servers.values()],
    connectMcplServer: async (config: { id: string; command?: string; url?: string; toolPrefix?: string }) => {
      calls.push(`connect:${config.id}`);
      if (servers.has(config.id)) throw new Error(`MCPL server "${config.id}" is already registered`);
      servers.set(config.id, {
        id: config.id,
        connected: true,
        retrying: false,
        toolPrefix: config.toolPrefix ?? `mcpl--${config.id}`,
        toolCount: 1,
        policyEstablished: true,
        effectiveGrant: ['channels.incoming'],
        maskedCapabilities: ['channels.streaming'],
        deniedCapabilities: ['contextHooks.beforeInference.inject.system'],
        allowHostCommands: false,
        manifestState: {
          lastValidatedRevision: 'sha256:validated',
          lastFetchedAt: Date.parse('2026-08-05T01:02:03.000Z'),
          lastNegotiatedAt: Date.parse('2026-08-05T01:02:04.000Z'),
        },
        command: config.command,
        url: config.url,
      });
    },
    disconnectMcplServer: async (id: string) => {
      calls.push(`disconnect:${id}`);
      servers.delete(id);
    },
    restartMcplServer: async (id: string, config?: { id: string; command?: string }) => {
      calls.push(`restart:${id}`);
      if (!servers.has(id) && !config) throw new Error(`MCPL server "${id}" is not configured`);
      const prev = servers.get(id);
      servers.set(id, {
        id,
        connected: true,
        retrying: false,
        toolPrefix: `mcpl--${id}`,
        toolCount: 1,
        policyEstablished: true,
        effectiveGrant: ['channels.incoming'],
        maskedCapabilities: ['channels.streaming'],
        deniedCapabilities: ['contextHooks.beforeInference.inject.system'],
        allowHostCommands: false,
        manifestState: {
          lastValidatedRevision: 'sha256:validated',
          lastFetchedAt: Date.parse('2026-08-05T01:02:03.000Z'),
          lastNegotiatedAt: Date.parse('2026-08-05T01:02:04.000Z'),
        },
        command: config?.command ?? prev?.command,
      });
    },
  };
  return { stub: stub as unknown as AgentFramework, servers, calls };
}

let dir: string;
let overlayPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpl-admin-'));
  overlayPath = join(dir, 'mcpl-servers.agent.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeModule(framework: AgentFramework, timeZone?: string) {
  const mod = new McplAdminModule({
    overlayPath,
    configPath: join(dir, 'mcpl-servers.json'),
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
  mod.setFramework(framework);
  return mod;
}

function call(mod: McplAdminModule, name: string, input: Record<string, unknown> = {}) {
  return mod.handleToolCall({ id: 'c1', name, input } as never);
}

/** That `text` says each thing the agent needs, whatever words surround it:
 *  a test pins those, not every word. */
function expectSays(text: unknown, ...parts: string[]): void {
  for (const part of parts) expect(String(text)).toContain(part);
}

/** mcpl_deploy's refusal of an entry the strict reading finds malformed:
 *  nothing deployed or saved, every problem named, and the call to make. */
function expectMalformed(text: unknown, problem: string): void {
  expectSays(text, 'Nothing was deployed', `malformed (${problem})`, 'nothing was saved', 'call mcpl-admin--mcpl_deploy again');
}

describe('mcpl_deploy', () => {
  test('deploys a new server: connects it and persists to the overlay', async () => {
    const { stub, servers, calls } = makeStubFramework();
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node', args: ['tool.js'] });

    expect(result.success).toBe(true);
    expect(calls).toEqual(['connect:mytool']);
    expect(servers.has('mytool')).toBe(true);
    expect(readAgentOverlay(overlayPath).mytool).toEqual({ command: 'node', args: ['tool.js'] });
  });

  test('redeploying a loaded server restarts it with the new config', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);

    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
    const result = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'bun' });

    expect(result.success).toBe(true);
    expect(calls).toEqual(['connect:mytool', 'restart:mytool']);
    expect(readAgentOverlay(overlayPath).mytool).toEqual({ command: 'bun' });
  });

  // An env value the boot would skip was
  // saved, then resolveOverlayEntry returned null and the deploy threw. A
  // new write is held to the plain shapes, and a number passes on as main
  // passed it: the child gets its text when it's spawned.
  test('an env value that isn\'t text, a number or true/false is refused before anything is saved; a number is deployed as given', async () => {
    const { stub } = makeStubFramework();
    const envs: unknown[] = [];
    const connect = (stub as unknown as { connectMcplServer: (c: { env?: unknown }) => Promise<void> }).connectMcplServer;
    (stub as unknown as { connectMcplServer: (c: { env?: unknown }) => Promise<void> }).connectMcplServer =
      async (config) => { envs.push(config.env); await connect(config); };
    const mod = makeModule(stub);

    const refused = await call(mod, 'mcpl_deploy', { id: 'nulled', command: 'node', env: { A: null } });
    expect(refused.success).toBe(false);
    expectMalformed(refused.error, "its env A isn't text, a number or true/false");
    expect(readAgentOverlay(overlayPath).nulled).toBeUndefined();
    expect(envs).toEqual([]);

    const deployed = await call(mod, 'mcpl_deploy', { id: 'door', command: 'node', env: { PORT: 3101 } });
    expect(deployed.success).toBe(true);
    expect(envs).toEqual([expect.objectContaining({ PORT: 3101 })]);
    expect(readAgentOverlay(overlayPath).door).toEqual({ command: 'node', env: { PORT: 3101 } });

    // An empty list is strict function calling's "unspecified": no env, and nothing refused.
    const strictModel = await call(mod, 'mcpl_deploy', { id: 'quiet', command: 'node', env: [] });
    expect(strictModel.success).toBe(true);
    expect(readAgentOverlay(overlayPath).quiet).toEqual({ command: 'node' });
  });

  // Each refusal says nothing was deployed and what to give instead, with an
  // id to copy where the given one has characters a tool name can't hold.
  test('rejects missing command/url, both at once, and bad ids, saying what to give', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);

    expectSays((await call(mod, 'mcpl_deploy', { id: 'x' })).error, 'Nothing was deployed', 'give `command`', 'or `url`', 'Neither was given');
    expectSays((await call(mod, 'mcpl_deploy', { id: 'x', command: 'a', url: 'ws://b' })).error, 'Nothing was deployed', 'not both');
    expectSays(
      (await call(mod, 'mcpl_deploy', { id: 'bad id!', command: 'a' })).error,
      'Nothing was deployed', 'the id "bad id!"', 'letters, digits, _ and -', 'Use one such as "bad-id"',
    );
    // Nothing in it a name can keep: a stand-in to copy.
    expectSays((await call(mod, 'mcpl_deploy', { id: 'üñï', command: 'a' })).error, 'Use one such as "my-server"');
    for (const id of [undefined, '  ', 5]) {
      expectSays(
        (await call(mod, 'mcpl_deploy', { id, command: 'a' })).error,
        'Nothing was deployed', 'mcpl-admin--mcpl_deploy needs `id`', 'such as "my-server"', 'letters, digits, _ and -',
      );
    }
    expect(calls).toEqual([]);
  });

  // A deployed child used to get AGENT_TIMEZONE alone, without the
  // refusal-reaction baseline every boot-loaded server gets.
  test('gives a deployed child the env the boot composes for every server', async () => {
    const { stub } = makeStubFramework();
    const configs: Array<{ id: string; env?: Record<string, string> }> = [];
    const connect = (stub as unknown as { connectMcplServer: (c: { id: string; env?: Record<string, string> }) => Promise<void> }).connectMcplServer;
    (stub as unknown as { connectMcplServer: (c: { id: string; env?: Record<string, string> }) => Promise<void> }).connectMcplServer =
      async (c) => { configs.push(c); return connect(c); };
    const mod = makeModule(stub, 'Pacific/Auckland');

    await call(mod, 'mcpl_deploy', { id: 'chat', command: 'node', env: { TOKEN: 'mine' } });
    await call(mod, 'mcpl_deploy', { id: 'quiet', command: 'node', env: { DISCORD_SUPPRESSED_REACTIONS_BASELINE: 'own', AGENT_TIMEZONE: 'Mars/Olympus' } });

    expect(configs[0]!.env).toEqual({
      DISCORD_SUPPRESSED_REACTIONS_BASELINE: REFUSAL_REACTION_BASELINE.join(','),
      TOKEN: 'mine',
      AGENT_TIMEZONE: 'Pacific/Auckland',
    });
    // The entry's own baseline overrides the default; the host's zone wins over the entry's.
    expect(configs[1]!.env!.DISCORD_SUPPRESSED_REACTIONS_BASELINE).toBe('own');
    expect(configs[1]!.env!.AGENT_TIMEZONE).toBe('Pacific/Auckland');
    // The overlay keeps only what the agent gave.
    expect(readAgentOverlay(overlayPath).chat).toEqual({ command: 'node', env: { TOKEN: 'mine' } });
  });

  // A field of the wrong kind used to be dropped (or coerced: a null arg
  // saved as "null"), so the deploy said it succeeded with what the caller
  // gave missing or changed.
  test('judges each field as given: a wrong kind is refused, and nothing is saved or connected', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ env: 'TOKEN=x' }, "its env isn't a map of names to values"],
      [{ env: 5 }, "its env isn't a map of names to values"],
      [{ env: false }, "its env isn't a map of names to values"],
      [{ env: ['A=1'] }, "its env isn't a map of names to values"],
      [{ args: 'server.js' }, "its args aren't a list of text"],
      [{ args: ['server.js', null] }, "its args aren't a list of text"],
      [{ toolPrefix: 5 }, "its toolPrefix isn't text"],
      [{ token: 5 }, "its token isn't text"],
      [{ access: 5 }, "its access isn't text"],
      [{ reconnect: 'yes' }, 'its reconnect is neither true nor false'],
      [{ enabledTools: 'say' }, "its enabledTools isn't a list of names"],
      [{ command: 5 }, "its command isn't text"],
      // The other kind's empty value is no unspecified form here.
      [{ reconnect: '' }, 'its reconnect is neither true nor false'],
      [{ args: '' }, "its args aren't a list of text"],
      [{ env: '' }, "its env isn't a map of names to values"],
      [{ toolPrefix: [] }, "its toolPrefix isn't text"],
      [{ enabledTools: '' }, "its enabledTools isn't a list of names"],
      // An empty name matches nothing: an allow-list of one is deny-all.
      [{ enabledTools: [''] }, 'its enabledTools holds an empty name, which matches nothing'],
      [{ disabledFeatureSets: ['a.b', '  '] }, 'its disabledFeatureSets holds an empty name, which matches nothing'],
    ];
    for (const [fields, problem] of cases) {
      const result = await call(mod, 'mcpl_deploy', { id: 'odd', command: 'node', ...fields });
      expectMalformed(result.error, problem);
    }
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  test('leaves out what strict function calling sends as unspecified, and saves list numbers as text', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    const result = await call(mod, 'mcpl_deploy', {
      id: 'plain', command: 'node', args: ['--port', 3101, true], env: null,
      token: '', access: '   ', toolPrefix: '  ', url: '', enabledTools: [], disabledFeatureSets: [],
    });
    expect(result.success).toBe(true);
    // An empty or blank toolPrefix would have been kept by the framework in place of its default prefix.
    expect(readAgentOverlay(overlayPath).plain).toEqual({ command: 'node', args: ['--port', '3101', 'true'] });
  });

  test('saves what it is given of each kind: reconnect false, and the four name lists with numbers as text', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    const result = await call(mod, 'mcpl_deploy', {
      id: 'shaped', url: 'ws://localhost:3101', reconnect: false,
      enabledFeatureSets: ['chat.*', 7], disabledFeatureSets: ['chat.admin'], enabledTools: ['say', true], disabledTools: ['*'],
    });
    expect(result.success).toBe(true);
    expect(readAgentOverlay(overlayPath).shaped).toEqual({
      url: 'ws://localhost:3101', transport: 'websocket', reconnect: false,
      enabledFeatureSets: ['chat.*', '7'], disabledFeatureSets: ['chat.admin'], enabledTools: ['say', 'true'], disabledTools: ['*'],
    });
  });

  test("names a host-managed access grant only where there's an identity, saving it trimmed", async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const refused = await call(mod, 'mcpl_deploy', { id: 'world', url: 'ws://localhost:3101', access: 'eidoverse' });
    expectSays(
      refused.error,
      'Nothing was deployed', 'no identity configured', 'Leave `access` out', '`token` instead', 'ask your operator to enable identity',
    );
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
    mod.setIdentity({ accessFor: async () => 'grant-token' });
    expect((await call(mod, 'mcpl_deploy', { id: 'world', url: 'ws://localhost:3101', access: '  eidoverse  ' })).success).toBe(true);
    expect(readAgentOverlay(overlayPath).world).toEqual({ url: 'ws://localhost:3101', transport: 'websocket', access: 'eidoverse' });
  });

  test('refuses a credential over ws:// to another machine, in a field or in the url, saving nothing, and takes wss:// or this machine', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setIdentity({ accessFor: async () => 'grant-token' });
    const byToken = await call(mod, 'mcpl_deploy', { id: 'tools', url: 'ws://tools.example:3101/mcpl', token: 't' });
    expectSays(
      byToken.error,
      'Nothing was deployed: its token would go to tools.example:3101 over unencrypted ws://', 'nothing was saved',
      'Use a wss:// url', 'ask your operator to add the server to the recipe',
    );
    const byGrant = await call(mod, 'mcpl_deploy', { id: 'world', url: 'ws://10.0.0.7/mcpl', access: 'eidoverse' });
    expect(byGrant.error).toStartWith('Nothing was deployed: the credential of its access grant "eidoverse" would go to 10.0.0.7 over unencrypted ws://');
    for (const url of ['ws://tools.example/mcpl?token=abc', 'ws://user:pass@tools.example/mcpl']) {
      const byUrl = await call(mod, 'mcpl_deploy', { id: 'pasted', url });
      expect(byUrl.error).toStartWith('Nothing was deployed: the user, password or token parameter in its url would go to tools.example over unencrypted ws://');
    }
    // A grant that isn't text is malformed, whatever the url: it names no grant to refuse.
    expectMalformed((await call(mod, 'mcpl_deploy', { id: 'odd', url: 'ws://tools.example', access: 5 })).error, "its access isn't text");
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
    expect((await call(mod, 'mcpl_deploy', { id: 'tools', url: 'wss://tools.example:3101/mcpl', token: 't' })).success).toBe(true);
    expect((await call(mod, 'mcpl_deploy', { id: 'local', url: 'ws://127.0.0.1:3101', token: 't' })).success).toBe(true);
    expect((await call(mod, 'mcpl_deploy', { id: 'open', url: 'ws://tools.example:3102' })).success).toBe(true);
    expect(Object.keys(readAgentOverlay(overlayPath)).sort()).toEqual(['local', 'open', 'tools']);
  });

  test('says a configured server is unchanged when a redeploy of it is refused for a credential over ws://', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    expect((await call(mod, 'mcpl_deploy', { id: 'tools', url: 'wss://tools.example/mcpl', token: 't' })).success).toBe(true);
    const refused = await call(mod, 'mcpl_deploy', { id: 'tools', url: 'ws://tools.example/mcpl', token: 't' });
    expectSays(refused.error, 'nothing was saved', 'The server already configured as "tools" is unchanged');
    expect(readAgentOverlay(overlayPath).tools).toEqual({ url: 'wss://tools.example/mcpl', transport: 'websocket', token: 't' });
  });

  test('refuses the id __proto__, which would never be saved, and takes any other name as an id', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const refused = await call(mod, 'mcpl_deploy', { id: '__proto__', command: 'node' });
    expectSays(refused.error, 'Nothing was deployed', '"__proto__" can\'t be a server id', 'Choose another id');
    expect(calls).toEqual([]);
    const named = await call(mod, 'mcpl_deploy', { id: 'constructor', command: 'node' });
    expect(named.success).toBe(true);
    expect(String(named.data)).not.toContain('malformed');
    expect(JSON.parse(readFileSync(overlayPath, 'utf-8')).mcplServers).toEqual({ constructor: { command: 'node' } });
  });

  test("keeps the overlay root's other keys, such as a misspelled one, when it saves", async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    writeFileSync(overlayPath, JSON.stringify({ mcplServer: { old: { disabled: true } }, mcplServers: {} }));
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
    expect(JSON.parse(readFileSync(overlayPath, 'utf-8'))).toEqual({
      mcplServer: { old: { disabled: true } },
      mcplServers: { mytool: { command: 'node' } },
    });
  });

  test('connect failure keeps the overlay entry and reports the error', async () => {
    const { stub } = makeStubFramework();
    (stub as unknown as { connectMcplServer: () => Promise<void> }).connectMcplServer =
      async () => { throw new Error('spawn ENOENT'); };
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_deploy', { id: 'broken', command: 'nonexistent' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn ENOENT');
    expect(readAgentOverlay(overlayPath).broken).toEqual({ command: 'nonexistent' });
  });
});

describe('mcpl_unload', () => {
  test('agent-deployed server: disconnects and deletes the overlay entry', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });

    const result = await call(mod, 'mcpl_unload', { id: 'mytool' });

    expect(result.success).toBe(true);
    expect(servers.has('mytool')).toBe(false);
    expect(readAgentOverlay(overlayPath).mytool).toBeUndefined();
  });

  test('recipe server: disconnects and writes a tombstone', async () => {
    const { stub, servers } = makeStubFramework();
    // Simulate a recipe-loaded server the module didn't deploy.
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_unload', { id: 'discord' });

    expect(result.success).toBe(true);
    expect(servers.has('discord')).toBe(false);
    expect(readAgentOverlay(overlayPath).discord).toEqual({ disabled: true });
  });

  test('persist:false leaves the overlay untouched', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_unload', { id: 'discord', persist: false });

    expect(result.success).toBe(true);
    expect(servers.has('discord')).toBe(false);
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  test('unknown server errors, naming the servers that are loaded', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    expectSays((await call(mod, 'mcpl_unload', { id: 'nope' })).error, 'Nothing was unloaded', 'no server "nope"', 'None is loaded');
    // An inherited key isn't an entry: nothing is tombstoned for it.
    expect((await call(mod, 'mcpl_unload', { id: 'constructor' })).success).toBe(false);
    expect(readAgentOverlay(overlayPath)).toEqual({});
    await call(mod, 'mcpl_deploy', { id: 'discord', command: 'node' });
    await call(mod, 'mcpl_deploy', { id: 'shell', command: 'node' });
    expectSays((await call(mod, 'mcpl_unload', { id: 'discrod' })).error, 'Nothing was unloaded', 'no server "discrod"', 'Loaded: "discord", "shell"');
  });

  test('an entry a concurrent mcpl_deploy writes during the disconnect is kept', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);
    const disconnect = (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer;
    (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer = async (id) => {
      await disconnect(id);
      // While the unload awaits, another call deploys a server.
      saveAgentOverlay(overlayPath, { ...readAgentOverlay(overlayPath), newer: { command: 'node' } });
    };
    const result = await call(mod, 'mcpl_unload', { id: 'discord' });
    expect(result.success).toBe(true);
    expect(readAgentOverlay(overlayPath)).toEqual({ newer: { command: 'node' }, discord: { disabled: true } });
  });

  // The unload used to disconnect first and read the overlay after, so a
  // file the boot stops on left the server down with nothing recorded.
  test('an overlay the boot would stop on refuses the unload, with the server still loaded', async () => {
    const { stub, servers, calls } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    writeFileSync(overlayPath, '{ not json');
    const mod = makeModule(stub);
    const result = await call(mod, 'mcpl_unload', { id: 'discord' });
    expect(result.success).toBe(false);
    // Said to the agent, not in the boot's words for the operator.
    expectSays(
      result.error,
      'mcpl-admin--mcpl_unload failed, and nothing was changed', `your overlay file, ${overlayPath}, isn't valid JSON`,
      'ask your operator to if you can\'t edit it', 'call mcpl-admin--mcpl_unload again', 'Don\'t move it aside',
    );
    expect(result.error).not.toContain('the agent overlay');
    expect(calls).toEqual(['connect:discord']);
    expect(servers.has('discord')).toBe(true);
  });

  test('a disconnect that fails changes nothing in the overlay, and says so', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }]);
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
    const before = readFileSync(overlayPath, 'utf-8');
    (stub as unknown as { disconnectMcplServer: () => Promise<void> }).disconnectMcplServer =
      async () => { throw new Error('stuck'); };
    const expectDisconnectFailed = (text: unknown, id: string, reason: string) => expectSays(
      text, `Server "${id}" couldn't be disconnected: ${reason}.`, 'It may still be loaded', 'changed nothing in your overlay',
      'mcpl-admin--mcpl_list shows whether it\'s loaded', 'call mcpl-admin--mcpl_unload again',
    );
    for (const id of ['discord', 'mytool']) {
      expectDisconnectFailed((await call(mod, 'mcpl_unload', { id })).error, id, 'stuck');
    }
    (stub as unknown as { disconnectMcplServer: () => Promise<void> }).disconnectMcplServer =
      async () => { throw 'socket wedged'; };
    expectDisconnectFailed((await call(mod, 'mcpl_unload', { id: 'discord', persist: false })).error, 'discord', 'socket wedged');
    expect(readFileSync(overlayPath, 'utf-8')).toBe(before);
  });

  // Once the server is gone, a failure to record the unload says so, and an
  // operator's server that isn't loaded can be unloaded again to record it.
  test('an overlay that fails after the disconnect says the server is gone and nothing was recorded, and a retry records it', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }]);
    const disconnect = (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer;
    (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer = async (id) => {
      await disconnect(id);
      writeFileSync(overlayPath, '{ not json');
    };
    const failed = await call(mod, 'mcpl_unload', { id: 'discord' });
    expectSays(
      failed.error,
      'Unloaded server "discord" — its tools are gone from your toolset.',
      `But your overlay couldn't be updated (your overlay file, ${overlayPath}, isn't valid JSON), so nothing was recorded`,
      'the operator\'s definition loads it again at the next host start',
      'mcpl-admin--mcpl_unload "discord" again records it once the file can be read and written',
    );
    expect(servers.has('discord')).toBe(false);
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: {} }));
    expect((await call(mod, 'mcpl_unload', { id: 'discord' })).data).toBe(
      'Server "discord" wasn\'t loaded in this session. Tombstoned in your overlay — it stays unloaded across host restarts; ' +
      'mcpl-admin--mcpl_deploy would load your own entry in its place, and removing the tombstone from your overlay file loads the ' +
      'operator\'s definition again.',
    );
    expect(readAgentOverlay(overlayPath).discord).toEqual({ disabled: true });
  });

  test('refuses the id __proto__, whose tombstone would never be saved', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: '__proto__', command: 'node' }]);
    expectSays((await call(mod, 'mcpl_unload', { id: '__proto__' })).error, 'Nothing was unloaded', 'your overlay can\'t record "__proto__"');
  });

  test('an id the overlay alone names is not disconnected: its entry is removed, or its tombstone kept', async () => {
    const { stub, calls } = makeStubFramework();
    (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer =
      async (id) => { calls.push(`disconnect:${id}`); throw new Error('MCPL subsystem is not initialized'); };
    saveAgentOverlay(overlayPath, { stale: { command: 'node' }, gone: { disabled: true } });
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'gone', command: 'node' }]);
    expect((await call(mod, 'mcpl_unload', { id: 'stale' })).data)
      .toBe('Server "stale" wasn\'t loaded in this session. Removed from your agent overlay.');
    expect((await call(mod, 'mcpl_unload', { id: 'gone' })).data).toBe(
      'Server "gone" wasn\'t loaded in this session. Tombstoned in your overlay — it stays unloaded across host restarts; ' +
      'mcpl-admin--mcpl_deploy would load your own entry in its place, and removing the tombstone from your overlay file loads the ' +
      'operator\'s definition again.',
    );
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({ gone: { disabled: true } });
  });

  // A malformed entry loads nothing for an id the operator doesn't define,
  // so unloading it removes it rather than leaving a tombstone in its place.
  test("a malformed entry is removed for an id the operator doesn't define", async () => {
    const { stub } = makeStubFramework();
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { stray: null, odd: { command: 'node', args: 'x' } } }));
    const mod = makeModule(stub);
    expect((await call(mod, 'mcpl_unload', { id: 'stray' })).data).toBe('Server "stray" wasn\'t loaded in this session. Removed from your agent overlay.');
    expect((await call(mod, 'mcpl_unload', { id: 'odd' })).data).toBe('Server "odd" wasn\'t loaded in this session. Removed from your agent overlay.');
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  test('a session-only unload says what the next start loads, read from the overlay', async () => {
    const { stub } = makeStubFramework();
    const connect = (id: string) => (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id, command: 'node' });
    await connect('discord');
    await connect('adhoc');
    await connect('heartbeat');
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }, { id: 'heartbeat', command: 'node' }]);
    await call(mod, 'mcpl_deploy', { id: 'mine', command: 'bun' });
    saveAgentOverlay(overlayPath, { ...readAgentOverlay(overlayPath), heartbeat: { disabled: true } });
    // An operator id the agent's entry replaces loads that entry, not the operator's definition.
    mod.setOperatorServers([{ id: 'discord', command: 'node' }, { id: 'heartbeat', command: 'node' }, { id: 'mine', command: 'node' }]);
    const unload = async (id: string) => String((await call(mod, 'mcpl_unload', { id, persist: false })).data);
    const head = (id: string) => `Unloaded server "${id}" — its tools are gone from your toolset. Session-only: `;
    expect(await unload('discord')).toBe(`${head('discord')}the operator's definition loads it again at the next host start.`);
    expect(await unload('mine')).toBe(`${head('mine')}your overlay entry loads it again at the next host start.`);
    expect(await unload('heartbeat')).toBe(`${head('heartbeat')}your overlay tombstones it, so the next host start leaves it unloaded.`);
    expect(await unload('adhoc')).toBe(`${head('adhoc')}nothing loads it at the next host start.`);
  });

  // Calls for one server run one at a time, so a deploy made while an
  // unload disconnects waits for it. Its entry, identical or not, is never
  // removed as the unload's, and each receipt is true when it's given.
  test('a deploy of the same id made during the disconnect runs after the unload, and keeps its entry', async () => {
    for (const command of ['bun', 'node']) {
      const { stub, servers, calls } = makeStubFramework();
      const mod = makeModule(stub);
      await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
      const disconnect = (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer;
      let redeploy: ReturnType<typeof call> | undefined;
      (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer = async (id) => {
        redeploy = call(mod, 'mcpl_deploy', { id: 'mytool', command });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await disconnect(id);
      };
      const unloaded = await call(mod, 'mcpl_unload', { id: 'mytool' });
      expect(unloaded.data).toBe('Unloaded server "mytool" — its tools are gone from your toolset. Removed from your agent overlay.');
      expect(String((await redeploy!).data)).toStartWith('Deployed server "mytool" — connected');
      expect(readAgentOverlay(overlayPath).mytool).toEqual({ command });
      expect(servers.has('mytool')).toBe(true);
      expect(calls).toEqual(['connect:mytool', 'disconnect:mytool', 'connect:mytool']);
    }
  });
});

describe('mcpl_list labels', () => {
  // agent-framework's listMcplServers carries a server's command and url but
  // not its transport, so the label is the command, else the url, as main
  // labelled it; for a definition naming both it can't say which the
  // framework opened.
  test('a server is labelled by its command, else its url, from the status the framework reports', async () => {
    const { stub } = makeStubFramework();
    const connect = (stub as unknown as { connectMcplServer: (c: { id: string; command?: string; url?: string; transport?: string }) => Promise<void> })
      .connectMcplServer;
    await connect({ id: 'world', url: 'wss://x.test/mcpl' });
    await connect({ id: 'both', command: 'node', url: 'wss://y.test/mcpl', transport: 'websocket' });
    await connect({ id: 'shell', command: 'node' });
    const status = stub.listMcplServers();
    expect(status.every((s) => !('transport' in s))).toBe(true);
    const text = String((await call(makeModule(stub), 'mcpl_list')).data);
    expect(text).toMatch(/world: CONNECTED .*, wss:\/\/x\.test\/mcpl$/m);
    expect(text).toMatch(/both: CONNECTED .*, node$/m);
    expect(text).toMatch(/shell: CONNECTED .*, node$/m);
  });
});

describe('mcpl_restart', () => {
  test('restarts a loaded server', async () => {
    const { stub, calls } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_restart', { id: 'discord' });

    expect(result.success).toBe(true);
    expect(calls).toEqual(['connect:discord', 'restart:discord']);
  });

  // An inherited name read straight off the overlay would be a function,
  // which the note would call a malformed entry.
  test('a server named like an inherited key gets no note about an entry it lacks', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'toString', command: 'node' });
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'toString', command: 'node' }]);
    const result = await call(mod, 'mcpl_restart', { id: 'toString' });
    expect(result.data).toBe('Restarted server "toString" — connected, 1 tools.');
  });
});

describe('mcpl_list', () => {
  test('shows live servers, sources, and tombstones', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'bun' });
    saveAgentOverlay(overlayPath, { ...readAgentOverlay(overlayPath), gone: { disabled: true } });

    const result = await call(mod, 'mcpl_list');

    expect(result.success).toBe(true);
    const text = String(result.data);
    expect(text).toContain('discord: CONNECTED');
    expect(text).toContain('mytool: CONNECTED');
    expect(text).toContain('policy=established');
    expect(text).toContain('grant=[channels.incoming]');
    expect(text).toContain('masked=[channels.streaming]');
    expect(text).toContain('denied=[contextHooks.beforeInference.inject.system]');
    expect(text).toContain('hostCommands=deny');
    expect(text).toContain(
      'manifest={revision="sha256:validated",' +
      'fetchedAt=2026-08-05T01:02:03.000Z,' +
      'negotiatedAt=2026-08-05T01:02:04.000Z}',
    );
    expect(text).toContain('source=agent-overlay');
    expect(text).toContain('gone: UNLOADED');
  });

  test("names a malformed overlay entry as one the boot skipped, and the operator's live server as the operator's", async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    writeFileSync(join(dir, 'mcpl-servers.json'), JSON.stringify({ mcplServers: { discord: { command: 'node' } } }));
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { discord: { command: 'node', args: 'server.js' }, stray: null } }));
    const mod = makeModule(stub);
    const text = String((await call(mod, 'mcpl_list')).data);
    expect(text).toContain('source=file/recipe');
    expect(text).not.toContain('source=agent-overlay');
    expect(text).toContain("discord: MALFORMED in your overlay (its args aren't a list of text, numbers or true/false), so the boot skips it");
    expect(text).toContain("stray: MALFORMED in your overlay (it isn't an object), so the boot skips it");
    // A restart reads the same file without throwing: it succeeds, and its
    // receipt says the entry is malformed and what the next start does.
    mod.setOperatorServers([{ id: 'discord', command: 'node' }]);
    const restarted = await call(mod, 'mcpl_restart', { id: 'discord' });
    expect(restarted.success).toBe(true);
    expect(String(restarted.data)).toContain('Restarted server "discord" — connected');
    expect(String(restarted.data)).toContain(
      'Your overlay entry for "discord" is malformed (its args aren\'t a list of text, numbers or true/false), ' +
      'so the next host start skips it and loads the operator\'s definition; redeploy with mcpl-admin--mcpl_deploy to replace it; ' +
      'mcpl-admin--mcpl_unload would tombstone the operator\'s definition, so it stays unloaded.',
    );
    expect(String(restarted.data)).not.toContain("couldn't be read");
    // A skipped entry takes no effect, so the last-connect sentence isn't said.
    expect(String(restarted.data)).not.toContain('last connect');
    // The advice says what mcpl_unload does for an id the operator defines,
    // and stays plain for one it doesn't.
    const listed = String((await call(mod, 'mcpl_list')).data);
    expect(listed).toContain(
      'discord: MALFORMED in your overlay (its args aren\'t a list of text, numbers or true/false), so the boot skips it ' +
      'and loads the operator\'s definition — redeploy with mcpl-admin--mcpl_deploy to replace it; mcpl-admin--mcpl_unload would tombstone the ' +
      'operator\'s definition, so it stays unloaded',
    );
    expect(listed).toContain("stray: MALFORMED in your overlay (it isn't an object), so the boot skips it — redeploy with mcpl-admin--mcpl_deploy, or mcpl-admin--mcpl_unload it");
    // Unloading it for good tombstones the operator's server over the malformed entry, as the advice says.
    await call(mod, 'mcpl_unload', { id: 'discord' });
    expect(readAgentOverlay(overlayPath).discord).toEqual({ disabled: true });
  });

  // A tombstone that carries other fields is a tombstone: mcpl_list says
  // so, and a restart says the overlay keeps the server unloaded at the next
  // start.
  test('a tombstone, junk fields and all, is listed as unloaded, and a restart of it says why', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }]);
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { discord: { disabled: true, command: 5, args: 'x', env: 'y' } } }));
    const listed = String((await call(mod, 'mcpl_list')).data);
    // For an id the operator defines, no tool brings its definition back:
    // only removing the tombstone does.
    const advice = 'mcpl-admin--mcpl_deploy would load your own entry in its place, and removing the tombstone from your overlay file ' +
      'loads the operator\'s definition again';
    expect(listed).toContain(`discord: UNLOADED (tombstoned in your overlay — ${advice})`);
    expect(listed).not.toContain('MALFORMED');
    // Refused before the framework is asked, saying what is loaded and why this isn't.
    const restarted = await call(mod, 'mcpl_restart', { id: 'discord' });
    expect(restarted.success).toBe(false);
    expectSays(
      restarted.error,
      'Nothing was restarted: no server "discord" is loaded in this session.', 'None is loaded.',
      `Your overlay tombstones "discord", so the next host start leaves it unloaded; ${advice}.`,
    );
    expect(calls).toEqual([]);
    // Nothing is left to reconnect with, so the last-connect sentence isn't said.
    expect(restarted.error).not.toContain('last connect');
    // An id nothing else defines is the agent's own, which a deploy restores.
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { mine: { disabled: true } } }));
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('mine: UNLOADED (tombstoned in your overlay — redeploy with mcpl-admin--mcpl_deploy to restore it)');
  });

  // A tombstone written while its server runs leaves it connected for this
  // session, and the list says so rather than UNLOADED.
  test('a tombstone for a server still connected is listed as tombstoned, not as unloaded', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'heartbeat', command: 'node' });
    const mod = makeModule(stub);
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { heartbeat: { disabled: true } } }));
    const listed = String((await call(mod, 'mcpl_list')).data);
    expect(listed).toContain('heartbeat: CONNECTED');
    expect(listed).toContain(
      'heartbeat: TOMBSTONED in your overlay, still connected this session; the next host start leaves it unloaded — ' +
      'redeploy with mcpl-admin--mcpl_deploy to restore it',
    );
    expect(listed).not.toContain('heartbeat: UNLOADED');
  });

  test('a recipe server named like an inherited key is labelled recipe, not file/recipe', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'constructor', command: 'node' });
    const mod = makeModule(stub);
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('constructor: CONNECTED');
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('source=recipe,');
  });

  test('distinguishes older-framework unknown and bounds untrusted revisions', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const server = servers.get('discord')!;
    delete server.manifestState;
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('manifest=unknown');

    server.manifestState = {
      lastValidatedRevision: `unsafe\n${'x'.repeat(100)}`,
      lastFetchedAt: null,
      lastNegotiatedAt: null,
    };
    const text = String((await call(mod, 'mcpl_list')).data);
    expect(text).toContain('manifest={revision="unsafe\\n');
    expect(text).not.toContain('unsafe\n');
    expect(text).toContain('...",fetchedAt=none,negotiatedAt=none}');
  });

  test("groups each server's tools by effective class and source", async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'chat', command: 'node' });
    const mod = makeModule(stub);

    // Older framework: no per-server classes reported.
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('classes=unknown');

    servers.get('chat')!.toolClasses = [
      { tool: 'chat--say', serverTool: 'say', class: ['comms'], source: 'server' },
      { tool: 'chat--send', serverTool: 'send', class: ['comms'], source: 'server' },
      { tool: 'chat--upload', serverTool: 'upload', class: ['files', 'comms'], source: 'override' },
      { tool: 'chat--probe', serverTool: 'probe', class: [], source: 'none' },
    ];
    expect(String((await call(mod, 'mcpl_list')).data)).toContain(
      'classes={comms/server: say,send; files+comms/override: upload; unclassed: probe}',
    );

    servers.get('chat')!.toolClasses = [];
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('classes={}');
  });
});

// Since agent-framework scrubs a stdio child's environment, an overlay entry
// that replaces the operator's definition runs without whatever of it the
// entry lacks: a resident's shell came back from mcpl_restart without
// SESSION_SERVER_TOKEN (2026-10-08), the restart reported success, and the
// first call said only "Connection lost". The receipts now say what the host
// knows, by name only.
describe('an overlay entry that replaces the operator definition', () => {
  const operatorShell = {
    id: 'shell',
    command: 'node',
    args: ['/abs/terminal-sessions/mcp-stdio-server.js'],
    env: { SESSION_SERVER_TOKEN: 's3cret-token', SESSION_SERVER_PORT: '3101' },
  };

  /** A host as it boots with the resident's 09-04-style entry: the overlay's
   *  shell is what loaded, in place of the operator's. */
  async function bootWithReplacement(entry: Record<string, unknown> = { command: 'node', args: ['mine.js'], env: { SESSION_SERVER_PORT: '3101' } }) {
    const fw = makeStubFramework();
    saveAgentOverlay(overlayPath, { shell: entry });
    await (fw.stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'shell', command: 'node' });
    const mod = makeModule(fw.stub);
    mod.setOperatorServers([operatorShell, { id: 'discord', command: 'node', env: { DISCORD_TOKEN: 'real' } }]);
    return { ...fw, mod };
  }

  test('mcpl_restart names what it lacks, never a value, and the way back', async () => {
    const { mod } = await bootWithReplacement();

    const result = await call(mod, 'mcpl_restart', { id: 'shell' });

    expect(result.success).toBe(true);
    const text = String(result.data);
    expect(text).toContain('Restarted server "shell" — connected');
    expect(text).toContain(
      'replaces the operator\'s definition of "shell" and lacks its env SESSION_SERVER_TOKEN, ' +
      'so the server runs without the operator\'s values for them. An overlay entry can\'t name host variables.',
    );
    expect(text).not.toContain('SESSION_SERVER_PORT');
    expect(text).not.toContain('s3cret-token');
    expect(text).toContain('To go back to the operator\'s definition, mcpl-admin--mcpl_unload "shell"');
    expect(text).toContain('the operator\'s loads again at the next host start');
    // The restart reconnects with the last connect's configuration; the note
    // reads the file, so an edit made before that connect is already in it.
    expect(text).toContain(
      'That describes your overlay file as it is now. The restart reconnects with the configuration of the server\'s ' +
      'last connect, at this host\'s start or your last mcpl-admin--mcpl_deploy of it, so a hand edit made since then takes effect ' +
      'at the next host start, unless a later mcpl-admin--mcpl_deploy replaces it.',
    );
  });

  test('mcpl_restart says nothing more when the entry lacks nothing, or replaces nothing', async () => {
    const { mod } = await bootWithReplacement({
      command: 'node',
      env: { SESSION_SERVER_PORT: '3101', SESSION_SERVER_TOKEN: 'its-own' },
    });
    expect(String((await call(mod, 'mcpl_restart', { id: 'shell' })).data)).toBe('Restarted server "shell" — connected, 1 tools.');

    // No operator definitions wired (an older embedding): no claim either way.
    const bare = makeStubFramework();
    await (bare.stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'shell', command: 'node' });
    expect(String((await call(makeModule(bare.stub), 'mcpl_restart', { id: 'shell' })).data))
      .toBe('Restarted server "shell" — connected, 1 tools.');
  });

  test('mcpl_deploy over an operator id says it replaces the definition, and what it lacks', async () => {
    const { mod } = await bootWithReplacement({ command: 'node' });

    const lacking = await call(mod, 'mcpl_deploy', { id: 'shell', command: 'node', args: ['rebuilt.js'] });
    expect(lacking.success).toBe(true);
    expect(String(lacking.data)).toContain(
      'replaces the operator\'s definition of "shell" and lacks its env SESSION_SERVER_PORT, SESSION_SERVER_TOKEN',
    );

    const carrying = await call(mod, 'mcpl_deploy', { id: 'discord', command: 'node', env: { DISCORD_TOKEN: 'mine' } });
    expect(carrying.success).toBe(true);
    expect(String(carrying.data)).toEndWith(' Your overlay entry replaces the operator\'s definition of "discord".');

    const fresh = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'bun' });
    expect(String(fresh.data)).not.toContain('operator');
  });

  // The likeliest next move after reading that receipt: name the variable in
  // the entry. Only a recipe substitutes it, so the receipt keeps the name
  // in what's lacking and says why, without showing the value.
  test('an entry that names a host variable still lacks it, and is told so', async () => {
    const { mod } = await bootWithReplacement();

    const result = await call(mod, 'mcpl_deploy', {
      id: 'shell',
      command: 'node',
      args: ['mine.js'],
      env: { SESSION_SERVER_PORT: '3101', SESSION_SERVER_TOKEN: '${SESSION_SERVER_TOKEN}' },
    });

    const text = String(result.data);
    expect(text).toContain('lacks its env SESSION_SERVER_TOKEN, so the server runs without the operator\'s values for them.');
    expect(text).toContain(
      'Your entry names a host variable in env SESSION_SERVER_TOKEN, and only a recipe substitutes those, ' +
      'so the server gets that text as written.',
    );
    expect(text).not.toContain('${SESSION_SERVER_TOKEN}');
    expect(String((await call(mod, 'mcpl_restart', { id: 'shell' })).data))
      .toContain('Your entry names a host variable in env SESSION_SERVER_TOKEN');
  });

  test('a host-variable reference in an entry that replaces nothing is told on deploy and restart', async () => {
    const { mod } = await bootWithReplacement();

    const deployed = String((await call(mod, 'mcpl_deploy', {
      id: 'weather', command: 'node', args: ['--key', '${WEATHER_KEY}'], env: { WEATHER_UNITS: 'metric' },
    })).data);
    // With no operator's definition to go back to, the way to get the value is the recipe.
    expect(deployed).toEndWith(
      'Your entry names a host variable in args, and only a recipe substitutes those, so the server gets that text as written. ' +
      'If the server needs the variable\'s value, ask your operator to add the server to the recipe, which fills host variables in.',
    );
    expect(deployed).not.toContain('operator\'s definition');
    expect(String((await call(mod, 'mcpl_restart', { id: 'weather' })).data))
      .toContain('Your entry names a host variable in args');
  });

  // Greptile's review of #227: a restart that throws keeps the note, and an
  // overlay file that can't be read costs only the note, never the restart's
  // own outcome or a quote of the file.
  test('a restart that throws still says what the entry lacks', async () => {
    const { stub, mod } = await bootWithReplacement();
    (stub as unknown as { restartMcplServer: () => Promise<void> }).restartMcplServer =
      async () => { throw new Error('spawn ENOENT'); };

    const result = await call(mod, 'mcpl_restart', { id: 'shell' });

    expect(result.success).toBe(false);
    expectSays(
      result.error,
      'The restart of "shell" didn\'t complete: spawn ENOENT.', 'It may now be disconnected',
      'mcpl-admin--mcpl_list shows its state', 'call mcpl-admin--mcpl_restart again',
    );
    expect(result.error).toContain('lacks its env SESSION_SERVER_TOKEN');
  });

  test('an overlay file that can\'t be read leaves the restart\'s own outcome', async () => {
    const { mod } = await bootWithReplacement();
    writeFileSync(overlayPath, '{"mcplServers": {"shell": {"env": {"SECRET": "s3cret-in-file"');

    const result = await call(mod, 'mcpl_restart', { id: 'shell' });

    expect(result.success).toBe(true);
    expect(String(result.data)).toBe(
      'Restarted server "shell" — connected, 1 tools. Your overlay file couldn\'t be read as an overlay, so nothing is said here ' +
      'about your entry, and the next host start will stop on it until the file is fixed.',
    );
    expect(String(result.data)).not.toContain('s3cret');
  });

  test('mcpl_list marks the replacement and what it lacks', async () => {
    const { mod } = await bootWithReplacement();

    const text = String((await call(mod, 'mcpl_list')).data);

    expect(text).toContain('source=agent-overlay (replaces the operator\'s definition; lacks its env SESSION_SERVER_TOKEN)');
    expect(text).not.toContain('s3cret-token');
  });

  test('mcpl_list credits the overlay only with an entry that put a server in place', async () => {
    // Neither command nor url: the boot skips this entry, so the live
    // server is the operator's (applyAgentOverlay / resolveOverlayEntry).
    const { mod } = await bootWithReplacement({ env: { SESSION_SERVER_TOKEN: 'x' } });

    const text = String((await call(mod, 'mcpl_list')).data);

    expect(text).toContain('source=recipe');
    expect(text).not.toContain('source=agent-overlay');
  });

  test('mcpl_unload of a replacement says the operator definition loads again at the next start', async () => {
    const { mod } = await bootWithReplacement();

    const result = await call(mod, 'mcpl_unload', { id: 'shell' });

    expect(result.success).toBe(true);
    expect(String(result.data)).toContain('the operator\'s definition of "shell" loads again at the next host start');
    expect(readAgentOverlay(overlayPath).shell).toBeUndefined();
  });
});

describe('restart and deploy report the connection they read', () => {
  test('mcpl_restart fails when the server is not connected afterwards', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; url: string }) => Promise<void> })
      .connectMcplServer({ id: 'world', url: 'wss://w/mcpl' });
    const restart = (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer;
    (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer = async (id) => {
      await restart(id);
      Object.assign(servers.get(id)!, { connected: false, retrying: true });
    };
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_restart', { id: 'world' });

    expect(result.success).toBe(false);
    expectSays(
      result.error,
      'Restarted server "world", but it isn\'t connected', 'it keeps retrying on its own', 'mcpl-admin--mcpl_list shows its state',
      'call mcpl-admin--mcpl_restart again', 'mcpl-admin--mcpl_unload removes it',
    );
  });

  test('mcpl_deploy fails, keeping the entry, when the connect resolves without a connection', async () => {
    const { stub, servers } = makeStubFramework();
    const connect = (stub as unknown as { connectMcplServer: (c: { id: string }) => Promise<void> }).connectMcplServer;
    (stub as unknown as { connectMcplServer: (c: { id: string }) => Promise<void> }).connectMcplServer = async (config) => {
      await connect(config);
      Object.assign(servers.get(config.id)!, { connected: false, retrying: true });
    };
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_deploy', { id: 'world', url: 'wss://down/mcpl' });

    expect(result.success).toBe(false);
    expectSays(
      result.error,
      'Server "world" was saved to your overlay, but it isn\'t connected', 'it keeps retrying on its own',
      'call mcpl-admin--mcpl_deploy again with the right one', 'call mcpl-admin--mcpl_restart once it\'s fixed',
      'mcpl-admin--mcpl_unload removes it',
    );
    expect(readAgentOverlay(overlayPath).world).toEqual({ url: 'wss://down/mcpl', transport: 'websocket' });
  });
});

// What the agent reads when a call fails: which tool, whether anything
// changed, and what to do, with the tools named as the agent calls them.
describe('a failed call says what changed and what to do', () => {
  test('a tool the module lacks is answered with the tools it has, as tools or as utilities, by the recipe surface', async () => {
    const { stub } = makeStubFramework();
    const all = ['mcpl-admin--mcpl_list', 'mcpl-admin--mcpl_deploy', 'mcpl-admin--mcpl_restart', 'mcpl-admin--mcpl_unload'];
    const asTools = (await call(makeModule(stub), 'mcpl_status')).error;
    expectSays(asTools, 'There\'s no tool "mcpl-admin--mcpl_status", so nothing ran', 'tools are', ...all);
    expect(asTools).not.toContain('utils');
    const utilities = new McplAdminModule({ overlayPath, configPath: join(dir, 'mcpl-servers.json'), surface: 'utilities' });
    utilities.setFramework(stub);
    expectSays((await call(utilities, 'mcpl_status')).error, 'no tool "mcpl-admin--mcpl_status"', 'utilities are', ...all, 'utils');
  });

  test('with no framework, before the host wires it or after the module stops, each tool says nothing changed and why', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    await mod.stop();
    const why = ['aren\'t running', 'starting up or shutting down', 'Try again once it\'s running', 'ask your operator'];
    // Listing changes nothing whatever happens, so it says only that it failed.
    const listed = (await call(mod, 'mcpl_list')).error;
    expectSays(listed, 'mcpl-admin--mcpl_list failed: ', ...why);
    expect(listed).not.toContain('nothing was changed');
    for (const name of ['mcpl_deploy', 'mcpl_restart', 'mcpl_unload']) {
      expectSays((await call(mod, name, { id: 'x', command: 'node' })).error, `mcpl-admin--${name} failed, and nothing was changed: `, ...why);
    }
    expect(calls).toEqual([]);
    expect(existsSync(overlayPath)).toBe(false);
  });

  test("an overlay that isn't JSON, or holds null, is said to the agent, with nothing saved or connected", async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const repair = (name: string) => [
      'Fix it, or ask your operator to if you can\'t edit it', `call mcpl-admin--${name} again`,
      'Don\'t move it aside: that would load every server you unloaded and drop your deployments',
    ];
    for (const [text, problem] of [['{ not json', "isn't valid JSON"], ['null', 'holds null, not an object with mcplServers']] as const) {
      writeFileSync(overlayPath, text);
      const deployed = (await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' })).error;
      expectSays(
        deployed, 'mcpl-admin--mcpl_deploy failed, and nothing was changed', `your overlay file, ${overlayPath}, ${problem}`,
        ...repair('mcpl_deploy'),
      );
      expect(deployed).not.toContain('the agent overlay');
      const listed = (await call(mod, 'mcpl_list')).error;
      expectSays(listed, 'mcpl-admin--mcpl_list failed: ', `your overlay file, ${overlayPath}, ${problem}`, ...repair('mcpl_list'));
      expect(listed).not.toContain('nothing was changed');
      expect(readFileSync(overlayPath, 'utf-8')).toBe(text);
    }
    expect(calls).toEqual([]);
    // The boot, which stops on the file, keeps the operator's words.
    expect(() => readAgentOverlay(overlayPath))
      .toThrow(`the agent overlay ${overlayPath} isn't an object with mcplServers: fix it`);
  });

  // The one change a deploy makes before it connects is the overlay's save,
  // so a failed save has an outcome of its own, and the catch-all's "nothing
  // was changed" stays true of everything that reaches it.
  test('a deploy whose overlay save fails says nothing was deployed, and connects nothing', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    // A link into a directory that doesn't exist: nothing to read, and the write fails.
    symlinkSync(join(dir, 'missing', 'overlay.json'), overlayPath);
    const result = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
    expectSays(
      result.error, 'Nothing was deployed: your overlay couldn\'t be saved (ENOENT', 'so "mytool" wasn\'t connected',
      'call mcpl-admin--mcpl_deploy again', 'ask your operator',
    );
    expect(calls).toEqual([]);
  });

  test("an operator's server file that isn't JSON fails only the listing, naming the file and never quoting it", async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    const configPath = join(dir, 'mcpl-servers.json');
    writeFileSync(configPath, '{ "mcplServers": { "chat": { "env": { "TOKEN": s3cret } } } }');
    const listed = (await call(mod, 'mcpl_list')).error;
    expectSays(
      listed, 'mcpl-admin--mcpl_list failed', `the operator's server file couldn't be read (${configPath} isn't valid JSON)`,
      'ask your operator', 'mcpl-admin--mcpl_deploy, mcpl-admin--mcpl_restart and mcpl-admin--mcpl_unload don\'t read it',
    );
    expect(listed).not.toContain('s3cret');
    expect((await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' })).success).toBe(true);
  });

  test("a restart of an id the framework holds no server for is refused before it's asked, naming what is loaded", async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'discord', command: 'node' });
    await call(mod, 'mcpl_deploy', { id: 'shell', command: 'node' });
    expectSays(
      (await call(mod, 'mcpl_restart', { id: 'discrod' })).error,
      'Nothing was restarted', 'no server "discrod" is loaded in this session', 'Loaded: "discord", "shell"',
    );
    expect(calls).toEqual(['connect:discord', 'connect:shell']);
  });
});
