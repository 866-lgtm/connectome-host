/**
 * The web UI's /files/<mount>/<path> passthrough serves a workspace file
 * through WorkspaceModule.readFileFromDisk, the read that keeps the mount's
 * link policy and reads a file only if its canonical path lies inside the
 * mount. These tests stand in for that read's answers. Every path also
 * resolves by its text to a real file (as resolveAbsolutePath answers), which
 * a read that went around readFileFromDisk would serve instead.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceReadError, type ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';

describe("the web UI's /files/ route serves only what the mount's own read gives", () => {
  let webUiModule: WebUiModule | undefined;
  let root: string;
  let baseUrl: string;
  const asked: string[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'webui-files-'));
    const staticRoot = join(root, 'web');
    mkdirSync(staticRoot);
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>files</title>');
    writeFileSync(join(root, 'resolved.txt'), 'bytes the mount does not give');
    const refusals: Record<string, WorkspaceReadError> = {
      'files/link.txt': new WorkspaceReadError('symlink', 'Symlinks are not allowed: files/link.txt', 'lstat'),
      'files/out.txt': new WorkspaceReadError('escape', 'Symlink escape detected: files/out.txt', 'realpath'),
      'nope/x.txt': new WorkspaceReadError('unknown_mount', 'Unknown mount: "nope". Available: files', 'parse'),
      'files/gone.txt': new WorkspaceReadError('not_found', 'File not found: files/gone.txt', 'lstat', 'ENOENT'),
      'files/album': new WorkspaceReadError('directory', 'Path is a directory: files/album', 'lstat'),
    };
    const workspace = {
      resolveAbsolutePath: () => join(root, 'resolved.txt'),
      readFileFromDisk: async (path: string) => {
        asked.push(path);
        const refusal = refusals[path];
        if (refusal) throw refusal;
        const bytes = Buffer.from("the mount's own bytes");
        return { bytes, size: bytes.byteLength, truncated: false };
      },
    };
    webUiModule = new WebUiModule({ port: 0, host: '127.0.0.1', staticDir: staticRoot });
    await webUiModule.start({} as ModuleContext);
    const port = __getSharedServerPortForTests();
    if (!port) throw new Error('webui server not bound; did start() succeed?');
    baseUrl = `http://127.0.0.1:${port}`;
    webUiModule.setApp({
      framework: {
        getAllAgents: () => [],
        getAllModules: () => [],
        getModule: (name: string) => (name === 'workspace' ? workspace : undefined),
        getSessionUsage: () => { throw new Error('no usage in this harness'); },
        onTrace: () => {},
      },
    } as never);
  });

  afterAll(async () => {
    await webUiModule?.stop();
    await __resetSharedServerForTests();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('a file the read gives is served with its bytes and type', async () => {
    const res = await fetch(`${baseUrl}/files/files/notes.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe("the mount's own bytes");
    expect(asked).toContain('files/notes.json');
  });

  test('a link the mount refuses, one leading outside it, and a path no mount holds are forbidden', async () => {
    for (const path of ['files/link.txt', 'files/out.txt', 'nope/x.txt']) {
      const res = await fetch(`${baseUrl}/files/${path}`);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('bytes the mount does not give');
    }
  });

  test('a path the read finds no file at is not found', async () => {
    for (const path of ['files/gone.txt', 'files/album']) {
      const res = await fetch(`${baseUrl}/files/${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('bytes the mount does not give');
    }
  });
});
