import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError, type ModuleContext } from '@animalabs/agent-framework';
import {
  DEFAULT_INSTRUCTIONS_HEADER,
  DEFAULT_INSTRUCTIONS_PATH,
  InstructionsModule,
  type WorkspaceDiskReader,
} from '../src/modules/instructions-module.js';

/**
 * The module reads through agent-framework's own WorkspaceModule here, on a
 * real mount, as production wires it. Every link these tests make leads to a
 * file inside the same mount; a read refused as leading outside a mount is
 * stood in for (agent-framework's own tests cover that read).
 */
describe('InstructionsModule', () => {
  let dir: string;
  let storeDir: string;
  let stores: Array<{ close?: () => void }>;
  let warnSpy: ReturnType<typeof spyOn>;
  let alerts: Array<{ kind: string; agent: string; message: string }>;
  let ctx: ModuleContext;

  /** A WorkspaceModule with one mount named `mountName` over the test's directory. */
  function workspaceOver(mountName: string): WorkspaceModule {
    const store = JsStore.openOrCreate({ path: join(storeDir, `store-${stores.length}`) });
    stores.push(store as { close?: () => void });
    const workspace = new WorkspaceModule({ mounts: [{ name: mountName, path: dir, mode: 'read-only', watch: 'never' }] });
    workspace.initStore(store);
    return workspace;
  }

  /** A module started on the test's context, reading through `workspace`. */
  async function moduleOver(workspace: WorkspaceDiskReader | null, config = {}): Promise<InstructionsModule> {
    const mod = new InstructionsModule({ agentName: 'resident', ...config });
    await mod.start(ctx);
    if (workspace) mod.setWorkspace(workspace);
    return mod;
  }

  const textOf = (injections: Awaited<ReturnType<InstructionsModule['gatherContext']>>) =>
    (injections[0]!.content[0] as { text: string }).text;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'instructions-module-'));
    storeDir = mkdtempSync(join(tmpdir(), 'instructions-store-'));
    stores = [];
    warnSpy = spyOn(console, 'error').mockImplementation(() => {});
    alerts = [];
    ctx = {
      // A subagent listed first: the alerts' name is the one the host gives.
      getAgents: () => [{ name: 'resident_fork_3' }, { name: 'resident' }],
      // Called through the context object, as the real ModuleContext needs.
      notifyOps(this: unknown, kind: string, agent: string, message: string) {
        expect(this).toBe(ctx);
        alerts.push({ kind, agent, message });
      },
    } as unknown as ModuleContext;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    for (const store of stores) store.close?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  test('injects file content under the default header at the default path', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'Always be excellent.\n');
    const mod = await moduleOver(workspaceOver('instructions'));

    const injections = await mod.gatherContext('resident');
    expect(injections).toHaveLength(1);
    expect(injections[0]!.namespace).toBe('instructions');
    expect(injections[0]!.position).toBe('system');
    expect(injections[0]!.content).toEqual([{
      type: 'text',
      text: `${DEFAULT_INSTRUCTIONS_HEADER}\n\nAlways be excellent.\n`,
    }]);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });

  test('exposes the shared-contract defaults', () => {
    expect(DEFAULT_INSTRUCTIONS_PATH).toBe('instructions/AGENTS.md');
    expect(new InstructionsModule().contextTimeoutMs).toBe(2000);
  });

  test('honors custom path, header, and position', async () => {
    writeFileSync(join(dir, 'HOUSE-RULES.md'), 'No shouting.');
    const mod = await moduleOver(workspaceOver('shared'), {
      path: 'shared/HOUSE-RULES.md',
      header: '## House rules',
      position: 'afterUser',
    });

    const injections = await mod.gatherContext('ephemeral-worker-1');
    expect(injections).toHaveLength(1);
    expect(injections[0]!.position).toBe('afterUser');
    expect(injections[0]!.content).toEqual([{ type: 'text', text: '## House rules\n\nNo shouting.' }]);
  });

  test('supports position beforeUser', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'x');
    const mod = await moduleOver(workspaceOver('instructions'), { position: 'beforeUser' });
    expect((await mod.gatherContext('a'))[0]!.position).toBe('beforeUser');
  });

  test('returns the same injection for every agent name', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'shared doc');
    const mod = await moduleOver(workspaceOver('instructions'));

    const forResident = await mod.gatherContext('resident');
    const forEphemeral = await mod.gatherContext('resident_fork_3');
    expect(forEphemeral).toEqual(forResident);
  });

  test('a missing file fails open with one warning and one alert across turns and agents', async () => {
    const mod = await moduleOver(workspaceOver('instructions'));

    expect(await mod.gatherContext('resident')).toEqual([]);
    expect(await mod.gatherContext('resident_fork_3')).toEqual([]);
    expect(await mod.gatherContext('resident')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual([{
      kind: 'instructions-unavailable',
      agent: 'resident',
      message: 'no instructions injected: File not found: instructions/AGENTS.md',
    }]);
  });

  test('an unknown mount fails open with one warning and one alert', async () => {
    const mod = await moduleOver(workspaceOver('instructions'), { path: 'nonexistent/AGENTS.md' });

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain('Unknown mount');
  });

  test('no workspace wired fails open, and says so', async () => {
    const mod = await moduleOver(null);
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual([{
      kind: 'instructions-unavailable',
      agent: 'resident',
      message: 'no instructions injected: the workspace module isn\'t wired, so no instructions can be read',
    }]);
  });

  test('recovers (and injects) once the file appears, standing the alert down once', async () => {
    const mod = await moduleOver(workspaceOver('instructions'));

    expect(await mod.gatherContext('a')).toEqual([]);
    writeFileSync(join(dir, 'AGENTS.md'), 'now I exist');
    const injections = await mod.gatherContext('a');
    expect(injections).toHaveLength(1);
    expect(textOf(injections)).toContain('now I exist');
    await mod.gatherContext('b');
    expect(alerts.map((a) => a.kind)).toEqual(['instructions-unavailable', 'instructions-unavailable-clear']);
    expect(alerts[1]!.agent).toBe('resident');

    // A recurrence warns and alerts again.
    rmSync(join(dir, 'AGENTS.md'));
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(alerts.map((a) => a.kind)).toEqual(['instructions-unavailable', 'instructions-unavailable-clear', 'instructions-unavailable']);
  });

  test('an edit reaches the next turn', async () => {
    const file = join(dir, 'AGENTS.md');
    writeFileSync(file, 'version one');
    const mod = await moduleOver(workspaceOver('instructions'));

    expect(textOf(await mod.gatherContext('a'))).toContain('version one');
    writeFileSync(file, 'version two, longer');
    expect(textOf(await mod.gatherContext('a'))).toContain('version two, longer');
    writeFileSync(file, 'version 3, longer!!');
    expect(textOf(await mod.gatherContext('a'))).toContain('version 3, longer!!');
  });

  test('truncates at maxBytes with an explicit marker', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'a'.repeat(100));
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 10 });

    expect(textOf(await mod.gatherContext('a'))).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n${'a'.repeat(10)}\n\n[truncated: first 10 of 100 bytes]`);
  });

  test('truncation never splits a multibyte character (no U+FFFD)', async () => {
    // '€' is 3 bytes in UTF-8; maxBytes: 4 keeps one full '€' plus the lead
    // byte of the second. The incomplete sequence must be dropped and the
    // marker report the actual kept byte count.
    writeFileSync(join(dir, 'AGENTS.md'), '€€€€');
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 4 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n€\n\n[truncated: first 3 of 12 bytes]`);
    expect(text).not.toContain('�');
  });

  test('a multibyte character ending exactly at the cap survives', async () => {
    // '€€' is 6 bytes; maxBytes: 3 keeps exactly one complete '€' — the
    // boundary backup must not chop a sequence that finished at the cap.
    writeFileSync(join(dir, 'AGENTS.md'), '€€');
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 3 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n€\n\n[truncated: first 3 of 6 bytes]`);
    expect(text).not.toContain('�');
  });

  test('does not truncate a file exactly at maxBytes', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'a'.repeat(10));
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 10 });

    expect(textOf(await mod.gatherContext('a'))).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n${'a'.repeat(10)}`);
  });

  test('reads at most maxBytes from an oversized file', async () => {
    // Only the first maxBytes influence the injection, whatever the file's
    // size: the read asks for no more.
    const big = 'begin-' + 'x'.repeat(512 * 1024) + '-end';
    writeFileSync(join(dir, 'AGENTS.md'), big);
    const mod = await moduleOver(workspaceOver('instructions'), { maxBytes: 1000 });

    const text = textOf(await mod.gatherContext('a'));
    expect(text).toBe(
      `${DEFAULT_INSTRUCTIONS_HEADER}\n\n${big.slice(0, 1000)}\n\n[truncated: first 1000 of ${big.length} bytes]`,
    );
    expect(text).not.toContain('-end');
  });

  // A recipe's mounts don't follow links, so a file that is itself a link is
  // refused even when it names another file in the same mount.
  test('a file that is itself a link injects nothing, and the alert names the remedy', async () => {
    writeFileSync(join(dir, 'real.md'), 'legit content');
    symlinkSync('real.md', join(dir, 'AGENTS.md'));
    const mod = await moduleOver(workspaceOver('instructions'));

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(alerts).toEqual([{
      kind: 'instructions-unavailable',
      agent: 'resident',
      message: 'no instructions injected: "instructions/AGENTS.md" is a link, which its mount doesn\'t follow: put the file itself at that path',
    }]);
  });

  test('a read refused as leading outside its mount injects nothing, and the alert names the remedy', async () => {
    const refusing: WorkspaceDiskReader = {
      readFileFromDisk: async () => {
        throw new WorkspaceReadError('escape', 'Symlink escape detected: instructions/AGENTS.md', 'realpath');
      },
    };
    const mod = await moduleOver(refusing);

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(alerts[0]!.message).toBe(
      'no instructions injected: "instructions/AGENTS.md" leads outside its mount: put the file itself at that path',
    );
  });

  test('a file reached through a linked directory inside the mount is read', async () => {
    // agent-framework refuses only a file that is itself a link; a linked
    // directory is followed while what it leads to stays inside the mount.
    mkdirSync(join(dir, 'v2'));
    writeFileSync(join(dir, 'v2', 'AGENTS.md'), 'the second version');
    symlinkSync('v2', join(dir, 'current'));
    const mod = await moduleOver(workspaceOver('instructions'), { path: 'instructions/current/AGENTS.md' });

    expect(textOf(await mod.gatherContext('a'))).toContain('the second version');
    expect(alerts).toEqual([]);
  });
});
