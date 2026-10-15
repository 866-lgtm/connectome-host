/**
 * ActivityModule reads the head of a file the workspace reports created or
 * modified for an origin hint, which routes its typing notice. It reads
 * through WorkspaceModule.readFileFromDisk, the read that keeps the mount's
 * link policy and reads a file only if its canonical path lies inside the
 * mount. The stand-in read refuses one path, and every path also resolves by
 * its text to a real file holding a hint, which a read that went around
 * readFileFromDisk would find instead.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceReadError, type ModuleContext, type TraceEvent } from '@animalabs/agent-framework';
import { ActivityModule } from '../src/modules/activity-module.js';

describe("the origin hint comes only from what the mount's own read gives", () => {
  test('a file the read gives sets the topic, one it refuses sets nothing, and only the head is asked for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'activity-origin-'));
    writeFileSync(join(dir, 'resolved.md'), 'origin: zulip#ops#from-around-the-read\n');
    const asked: Array<{ path: string; maxBytes?: number }> = [];
    const workspace = {
      resolveAbsolutePath: () => join(dir, 'resolved.md'),
      readFileFromDisk: async (path: string, options?: { maxBytes?: number }) => {
        asked.push({ path, maxBytes: options?.maxBytes });
        if (path === 'files/refused.md') {
          throw new WorkspaceReadError('escape', 'Symlink escape detected: files/refused.md', 'realpath');
        }
        const bytes = Buffer.from('origin: zulip#ops#from-the-mount\n');
        return { bytes, size: bytes.byteLength, truncated: false };
      },
    };
    const typing: Array<{ channel: string; metadata: unknown }> = [];
    const listeners = new Set<(event: TraceEvent) => void>();
    const framework = {
      onTrace: (cb: (event: TraceEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      channels: {
        startTyping: (channel: string, metadata?: unknown) => { typing.push({ channel, metadata }); },
        stopTyping: () => {},
      },
    };
    const trace = (type: string) => { for (const l of [...listeners]) l({ type, agentName: 'clerk' } as unknown as TraceEvent); };
    const module = new ActivityModule({ initialChannels: ['zulip:ops'] });
    await module.start({
      getState: () => null,
      setState: () => {},
      getModule: (name: string) => (name === 'workspace' ? workspace : undefined),
    } as unknown as ModuleContext);
    module.setFramework(framework as never);

    await module.onProcess({ type: 'workspace:created', paths: ['files/refused.md'] } as never, {} as never);
    trace('inference:started');
    expect(typing.at(-1)).toEqual({ channel: 'zulip:ops', metadata: undefined });
    trace('inference:completed');

    await module.onProcess({ type: 'workspace:modified', paths: ['files/given.md'] } as never, {} as never);
    trace('inference:started');
    expect(typing.at(-1)).toEqual({ channel: 'zulip:ops', metadata: { topic: 'from-the-mount' } });

    expect(asked).toEqual([
      { path: 'files/refused.md', maxBytes: 2048 },
      { path: 'files/given.md', maxBytes: 2048 },
    ]);
  });
});
