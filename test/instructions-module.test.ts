import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_INSTRUCTIONS_HEADER,
  DEFAULT_INSTRUCTIONS_PATH,
  InstructionsModule,
  type WorkspacePathResolver,
} from '../src/modules/instructions-module.js';

/**
 * Minimal stand-in for WorkspaceModule.resolveAbsolutePath: one mount named
 * `mountName` rooted at `root`, unknown mounts resolve to null (the real
 * module's fail-open contract). Mirrors the real parsePath in resolving a
 * bare mount name to the mount root — the module uses that for its realpath
 * containment check.
 */
function makeResolver(mountName: string, root: string): WorkspacePathResolver {
  return {
    resolveAbsolutePath(mountPrefixedPath: string): string | null {
      const slashIdx = mountPrefixedPath.indexOf('/');
      const name = slashIdx >= 0 ? mountPrefixedPath.slice(0, slashIdx) : mountPrefixedPath;
      if (name !== mountName) return null;
      const rel = slashIdx >= 0 ? mountPrefixedPath.slice(slashIdx + 1) : '';
      return resolve(root, rel);
    },
  };
}

describe('InstructionsModule', () => {
  let dir: string;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'instructions-module-'));
    warnSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test('injects file content under the default header at the default path', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'Always be excellent.\n');
    const mod = new InstructionsModule();
    mod.setWorkspace(makeResolver('instructions', dir));

    const injections = await mod.gatherContext('resident');
    expect(injections).toHaveLength(1);
    expect(injections[0].namespace).toBe('instructions');
    expect(injections[0].position).toBe('system');
    expect(injections[0].content).toEqual([{
      type: 'text',
      text: `${DEFAULT_INSTRUCTIONS_HEADER}\n\nAlways be excellent.\n`,
    }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('exposes the shared-contract defaults', () => {
    expect(DEFAULT_INSTRUCTIONS_PATH).toBe('instructions/AGENTS.md');
    expect(new InstructionsModule().contextTimeoutMs).toBe(2000);
  });

  test('honors custom path, header, and position', async () => {
    writeFileSync(join(dir, 'HOUSE-RULES.md'), 'No shouting.');
    const mod = new InstructionsModule({
      path: 'shared/HOUSE-RULES.md',
      header: '## House rules',
      position: 'afterUser',
    });
    mod.setWorkspace(makeResolver('shared', dir));

    const injections = await mod.gatherContext('ephemeral-worker-1');
    expect(injections).toHaveLength(1);
    expect(injections[0].position).toBe('afterUser');
    expect(injections[0].content).toEqual([{ type: 'text', text: '## House rules\n\nNo shouting.' }]);
  });

  test('supports position beforeUser', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'x');
    const mod = new InstructionsModule({ position: 'beforeUser' });
    mod.setWorkspace(makeResolver('instructions', dir));
    expect((await mod.gatherContext('a'))[0].position).toBe('beforeUser');
  });

  test('returns the same injection for every agent name', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'shared doc');
    const mod = new InstructionsModule();
    mod.setWorkspace(makeResolver('instructions', dir));

    const forResident = await mod.gatherContext('resident');
    const forEphemeral = await mod.gatherContext('resident_fork_3');
    expect(forEphemeral).toEqual(forResident);
  });

  test('missing file fails open with a single warning across turns', async () => {
    const mod = new InstructionsModule();
    mod.setWorkspace(makeResolver('instructions', dir));

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('unknown mount fails open with a single warning', async () => {
    const mod = new InstructionsModule({ path: 'nonexistent/AGENTS.md' });
    mod.setWorkspace(makeResolver('instructions', dir));

    expect(await mod.gatherContext('a')).toEqual([]);
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('no workspace wired fails open', async () => {
    const mod = new InstructionsModule();
    expect(await mod.gatherContext('a')).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('recovers (and injects) once the file appears', async () => {
    const mod = new InstructionsModule();
    mod.setWorkspace(makeResolver('instructions', dir));

    expect(await mod.gatherContext('a')).toEqual([]);
    writeFileSync(join(dir, 'AGENTS.md'), 'now I exist');
    const injections = await mod.gatherContext('a');
    expect(injections).toHaveLength(1);
    expect((injections[0].content[0] as { text: string }).text).toContain('now I exist');
  });

  test('caches by (mtime, size) and rereads when the file changes', async () => {
    const file = join(dir, 'AGENTS.md');
    writeFileSync(file, 'version one');
    const mod = new InstructionsModule();
    mod.setWorkspace(makeResolver('instructions', dir));

    const first = await mod.gatherContext('a');
    const second = await mod.gatherContext('a');
    // Unchanged stat → cache hit → identical array, no reread.
    expect(second).toBe(first);

    // Content change (different size) → cache miss → new content.
    writeFileSync(file, 'version two, longer');
    const third = await mod.gatherContext('a');
    expect(third).not.toBe(first);
    expect((third[0].content[0] as { text: string }).text).toContain('version two, longer');

    // mtime bump alone (same size, same content) also invalidates.
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const fourth = await mod.gatherContext('a');
    expect(fourth).not.toBe(third);
    expect(fourth).toEqual(third);
  });

  test('truncates at maxBytes with an explicit marker', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'a'.repeat(100));
    const mod = new InstructionsModule({ maxBytes: 10 });
    mod.setWorkspace(makeResolver('instructions', dir));

    const injections = await mod.gatherContext('a');
    const text = (injections[0].content[0] as { text: string }).text;
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n${'a'.repeat(10)}\n\n[truncated: first 10 of 100 bytes]`);
  });

  test('truncation never splits a multibyte character (no U+FFFD)', async () => {
    // '€' is 3 bytes in UTF-8; maxBytes: 4 keeps one full '€' plus the lead
    // byte of the second. The incomplete sequence must be dropped and the
    // marker report the actual kept byte count.
    writeFileSync(join(dir, 'AGENTS.md'), '€€€€');
    const mod = new InstructionsModule({ maxBytes: 4 });
    mod.setWorkspace(makeResolver('instructions', dir));

    const text = ((await mod.gatherContext('a'))[0].content[0] as { text: string }).text;
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n€\n\n[truncated: first 3 of 12 bytes]`);
    expect(text).not.toContain('�');
  });

  test('a multibyte character ending exactly at the cap survives', async () => {
    // '€€' is 6 bytes; maxBytes: 3 keeps exactly one complete '€' — the
    // boundary backup must not chop a sequence that finished at the cap.
    writeFileSync(join(dir, 'AGENTS.md'), '€€');
    const mod = new InstructionsModule({ maxBytes: 3 });
    mod.setWorkspace(makeResolver('instructions', dir));

    const text = ((await mod.gatherContext('a'))[0].content[0] as { text: string }).text;
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n€\n\n[truncated: first 3 of 6 bytes]`);
    expect(text).not.toContain('�');
  });

  test('does not truncate a file exactly at maxBytes', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'a'.repeat(10));
    const mod = new InstructionsModule({ maxBytes: 10 });
    mod.setWorkspace(makeResolver('instructions', dir));

    const text = ((await mod.gatherContext('a'))[0].content[0] as { text: string }).text;
    expect(text).toBe(`${DEFAULT_INSTRUCTIONS_HEADER}\n\n${'a'.repeat(10)}`);
  });

  test('reads at most maxBytes from an oversized file', async () => {
    // Regression for the unbounded-read finding: a large mounted file must
    // never be loaded whole. The observable contract is that only the first
    // maxBytes influence the injection regardless of file size.
    const big = 'begin-' + 'x'.repeat(512 * 1024) + '-end';
    writeFileSync(join(dir, 'AGENTS.md'), big);
    const mod = new InstructionsModule({ maxBytes: 1000 });
    mod.setWorkspace(makeResolver('instructions', dir));

    const text = ((await mod.gatherContext('a'))[0].content[0] as { text: string }).text;
    expect(text).toBe(
      `${DEFAULT_INSTRUCTIONS_HEADER}\n\n${big.slice(0, 1000)}\n\n[truncated: first 1000 of ${big.length} bytes]`,
    );
    expect(text).not.toContain('-end');
  });

  test('rejects an in-mount symlink targeting a file outside the mount', async () => {
    // Regression for the symlink-escape finding: resolveAbsolutePath's
    // containment is lexical, so a symlink inside the mount must not import
    // outside content into the trusted instructions block.
    const outside = mkdtempSync(join(tmpdir(), 'instructions-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SECRET');
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'AGENTS.md'));
      const mod = new InstructionsModule();
      mod.setWorkspace(makeResolver('instructions', dir));

      expect(await mod.gatherContext('a')).toEqual([]);
      expect(await mod.gatherContext('a')).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('outside its mount');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a symlink retargeted outside the mount stops injecting (no stale cache)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'instructions-outside-'));
    try {
      writeFileSync(join(dir, 'real.md'), 'legit content');
      symlinkSync(join(dir, 'real.md'), join(dir, 'AGENTS.md'));
      const mod = new InstructionsModule();
      mod.setWorkspace(makeResolver('instructions', dir));

      // In-mount symlink is fine — realpath stays under the mount root.
      const before = await mod.gatherContext('a');
      expect((before[0].content[0] as { text: string }).text).toContain('legit content');

      // Retarget outside: injection must stop, not serve the cached content.
      writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SECRET');
      rmSync(join(dir, 'AGENTS.md'));
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'AGENTS.md'));
      expect(await mod.gatherContext('a')).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
