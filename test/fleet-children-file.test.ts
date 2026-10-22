/**
 * The fleet's side of the update contract: the children file an install's
 * launcher reads before a switch, the fleet's record of a child from its
 * spawn, and children that never get the install's root, so none of them
 * acts as the install's host.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule, type FleetModuleConfig } from '../src/modules/fleet-module.js';
import * as contract from '../src/update/contract.js';
import { childrenFilePath, readRecord, type ChildrenFile } from '../src/update/contract.js';

type Result = Awaited<ReturnType<FleetModule['handleToolCall']>>;
type Launch = { name: string; recipe: string; dataDir: string; env?: Record<string, string> };
type Internal = { handleLaunch: (input: Launch, opts: { viaAutoStart: boolean }) => Promise<Result> };
type Record_ = { children: Record<string, { name: string; pid: number | null; status: string }> };

const fixtures: Array<{ fleet: FleetModule; dir: string }> = [];
afterEach(async () => {
  for (const { fleet, dir } of fixtures.splice(0)) {
    await fleet.stop().catch(() => { /* already stopped */ });
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CONNECTOME_INSTALL_ROOT;
});

/** A started fleet whose store is a stand-in: `record` is what it holds, and
 *  `writes` each record set, in order, with each sync between them. */
async function startedFleet(config: FleetModuleConfig = {}, store: { record?: unknown; unreadable?: true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-children-file-'));
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({}));
  const fleet = new FleetModule({
    childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'),
    socketWaitTimeoutMs: 10_000,
    readyTimeoutMs: 10_000,
    gracefulShutdownMs: 100,
    sigtermEscalationMs: 100,
    ...config,
  });
  fixtures.push({ fleet, dir });
  let record: unknown = store.record ?? null;
  const writes: Array<Record_ | 'sync'> = [];
  /** What the children file listed at each sync. */
  const atSync: Array<ChildrenFile['children']> = [];
  fleet.setStoreSync(() => {
    writes.push('sync');
    if (config.childrenFile) {
      try {
        atSync.push(listed(config.childrenFile));
      } catch {
        // A file the test made unreadable: the fleet's own read says so.
      }
    }
  });
  await fleet.start({
    getState: () => {
      if (store.unreadable) throw new Error('the store refused the read');
      return record;
    },
    setState: (next: unknown) => { record = structuredClone(next); writes.push(record as Record_); },
  } as unknown as Parameters<FleetModule['start']>[0]);
  return {
    fleet, dir, writes, atSync, record: () => record,
    input: (name = 'leaf'): Launch => ({ name, recipe, dataDir: join(dir, name) }),
  };
}

const launch = (fleet: FleetModule, input: Launch): Promise<Result> =>
  (fleet as unknown as Internal).handleLaunch(input, { viaAutoStart: true });

/** This machine's boot id, as the fleet reads it, or null where there's none. */
function machineBootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** A pid no process holds now: one that ran and exited. */
function deadPid(): number {
  return spawnSync('true').pid!;
}

function parentDataDir(): string {
  const parentData = mkdtempSync(join(tmpdir(), 'fleet-children-parent-'));
  fixtures.push({ fleet: new FleetModule({}), dir: parentData });
  return parentData;
}

/** Waits until `ready` holds, for up to 8 s. */
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && !ready()) await Bun.sleep(10);
}

const listed = (file: string) => readRecord<ChildrenFile>(file, 'children file')?.children ?? [];

describe("the fleet's children file", () => {
  test("lists each child with its data directory, and the process of each that may be running, with the machine's boot", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    expect((await launch(fleet, input('leaf'))).success).toBe(true);
    expect((await launch(fleet, input('twig'))).success).toBe(true);
    const pid = (name: string) => fleet.getChildren().get(name)!.pid;
    expect(pid('leaf')).toBeNumber();
    const boot = machineBootId();
    expect(listed(childrenFile)).toEqual([
      { name: 'leaf', pid: pid('leaf'), bootId: boot, dataDir: input('leaf').dataDir },
      { name: 'twig', pid: pid('twig'), bootId: boot, dataDir: input('twig').dataDir },
    ]);

    expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'twig' } })).success).toBe(true);
    expect(listed(childrenFile)).toEqual([
      { name: 'leaf', pid: pid('leaf'), bootId: boot, dataDir: input('leaf').dataDir },
      { name: 'twig', pid: null, bootId: boot, dataDir: input('twig').dataDir },
    ]);
  });

  test("a child's boot is null where the machine gives none", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const noBoot = spyOn(FleetModule.prototype as unknown as { bootId: () => string | undefined }, 'bootId')
      .mockReturnValue(undefined);
    try {
      const { fleet, input } = await startedFleet({ childrenFile });
      expect((await launch(fleet, input())).success).toBe(true);
      expect(listed(childrenFile)).toEqual([
        { name: 'leaf', pid: fleet.getChildren().get('leaf')!.pid, bootId: null, dataDir: input().dataDir },
      ]);
    } finally {
      noBoot.mockRestore();
    }
  });

  test('a child is in the record, synced, and then in the file, from the moment its process exists, before it is ready', async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input, writes, atSync } = await startedFleet({ childrenFile });
    // A child that never opens its socket stays starting until something ends it.
    writeFileSync(input().recipe, JSON.stringify({ noSocket: true }));
    const launched = launch(fleet, input());
    await until(() => typeof listed(childrenFile).find((c) => c.name === 'leaf')?.pid === 'number');
    const child = fleet.getChildren().get('leaf')!;
    expect(child.status).toBe('starting');
    expect(listed(childrenFile).find((c) => c.name === 'leaf')?.pid).toBe(child.pid);
    // The record held the starting child, with its pid, and was synced before
    // the file listed it.
    const recorded = writes.findIndex((w) => w !== 'sync' && w.children.leaf?.status === 'starting' && w.children.leaf.pid === child.pid);
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(writes[recorded + 1]).toBe('sync');
    // At that sync, the file didn't list the child yet: it follows the record.
    expect(atSync[0]).toEqual([]);
    // Stopping the fleet ends the child, and with it the launch.
    await fleet.stop();
    expect((await launched).success).toBe(false);
  });

  test('a fleet started on a record taken while a child starts keeps the child, lists it, and starts no second copy', async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const first = await startedFleet({ childrenFile });
    writeFileSync(first.input().recipe, JSON.stringify({ noSocket: true }));
    const launched = launch(first.fleet, first.input());
    await until(() => typeof listed(childrenFile).find((c) => c.name === 'leaf')?.pid === 'number');
    const pid = first.fleet.getChildren().get('leaf')!.pid!;
    // The next parent, as after this one was killed: its store holds the record
    // made at the spawn.
    const next = await startedFleet({ childrenFile }, { record: first.record() });
    expect(next.fleet.getChildren().get('leaf')).toMatchObject({ status: 'starting', pid });
    expect(listed(childrenFile)).toEqual([{ name: 'leaf', pid, bootId: machineBootId(), dataDir: first.input().dataDir }]);
    const again = await launch(next.fleet, first.input());
    expect(again.success).toBe(false);
    const launches = join(first.input().dataDir, 'launches.jsonl');
    await until(() => existsSync(launches));
    expect(readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
    await first.fleet.stop();
    expect((await launched).success).toBe(false);
  });

  test('a fleet adopting its living children writes its record and the file once, holding them all', async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const first = await startedFleet({ childrenFile });
    expect((await launch(first.fleet, first.input('leaf'))).success).toBe(true);
    expect((await launch(first.fleet, first.input('twig'))).success).toBe(true);
    const write = spyOn(contract, 'writeJsonAtomic');
    let next: Awaited<ReturnType<typeof startedFleet>>;
    let fileWrites: number;
    try {
      next = await startedFleet({ childrenFile }, { record: first.record() });
      fileWrites = write.mock.calls.filter(([path]) => path === childrenFile).length;
    } finally {
      write.mockRestore();
    }
    expect(fileWrites).toBe(1);
    expect(next.fleet.getChildren().get('leaf')?.adopted).toBe(true);
    expect(next.fleet.getChildren().get('twig')?.adopted).toBe(true);
    // Each reattached child's ready event came while the map held only the
    // children taken back so far; nothing was written until all were back.
    const records = next.writes.filter((w): w is Record_ => w !== 'sync');
    expect(records.map((w) => Object.keys(w.children).sort())).toEqual([['leaf', 'twig']]);
    expect(listed(childrenFile).map((c) => c.name)).toEqual(['leaf', 'twig']);
  });

  test("a write keeps what it doesn't replace: another directory's entry, with its pid only while it may run, another generation still running in its own child's directory, and an entry it can't read as a child, on a machine that gives a boot id and on one that gives none", async () => {
    for (const givesNone of [false, true]) {
      const noBoot = givesNone
        ? spyOn(FleetModule.prototype as unknown as { bootId: () => string | undefined }, 'bootId').mockReturnValue(undefined)
        : undefined;
      try {
        const parentData = parentDataDir();
        const childrenFile = childrenFilePath(parentData);
        const { fleet, input } = await startedFleet({ childrenFile });
        const boot = givesNone ? null : machineBootId();
        // This test's own process stands for a child that still runs.
        const running = { name: 'kid-of-another-session', pid: process.pid, bootId: boot, dataDir: join(parentData, 'elsewhere') };
        const stopped = { name: 'old-kid', pid: deadPid(), bootId: boot, dataDir: join(parentData, 'gone') };
        const sameDirRunning = { name: 'another-generation', pid: process.pid, bootId: boot, dataDir: input().dataDir };
        const sameDirStopped = { name: 'earlier-generation', pid: deadPid(), bootId: boot, dataDir: input().dataDir };
        // A pid of this boot's held by a live process, under another boot's
        // id, isn't that child's; under no boot id at all, it may be.
        const otherBoot = { name: 'kid-of-another-boot', pid: process.pid, bootId: 'another-boot', dataDir: join(parentData, 'rebooted') };
        const unknownBoot = { name: 'kid-of-an-unknown-boot', pid: process.pid, bootId: null, dataDir: join(parentData, 'unknown') };
        const sameDirOtherBoot = { name: 'rebooted-generation', pid: process.pid, bootId: 'another-boot', dataDir: input().dataDir };
        // Entries without a child's shape, kept as they are.
        const unreadable = [
          { name: 'no-directory', pid: 12, bootId: null },
          { name: 'odd-pid', pid: 'twelve', bootId: null, dataDir: join(parentData, 'odd') },
          { dataDir: join(parentData, 'nameless'), note: 'from elsewhere' },
          null,
        ];
        writeFileSync(childrenFile, JSON.stringify({
          v: 1,
          children: [running, sameDirStopped, sameDirRunning, sameDirOtherBoot, otherBoot, unknownBoot, ...unreadable, stopped],
        }));
        expect((await launch(fleet, input())).success).toBe(true);
        // Where the machine gives no boot id, as on macOS, nothing tells
        // another boot's pid from this one's, so the launcher reads a live one
        // as possibly running, and the write keeps it.
        expect(listed(childrenFile)).toEqual([
          { name: 'leaf', pid: fleet.getChildren().get('leaf')!.pid, bootId: boot, dataDir: input().dataDir },
          running,
          sameDirRunning,
          ...(boot === null ? [sameDirOtherBoot] : []),
          boot === null ? otherBoot : { ...otherBoot, pid: null },
          unknownBoot,
          ...unreadable,
          { ...stopped, pid: null },
        ] as ChildrenFile['children']);
      } finally {
        noBoot?.mockRestore();
      }
    }
  });

  test("the pid a child the fleet has seen exit had can't stand for a live process that holds it now", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    expect((await launch(fleet, input('leaf'))).success).toBe(true);
    expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
    // As if the exited child's pid had since been reused by a live process,
    // which an entry of another session lists for the same directory.
    (fleet.getChildren().get('leaf') as { pid: number | null }).pid = process.pid;
    const live = { name: 'another-generation', pid: process.pid, bootId: machineBootId(), dataDir: input('leaf').dataDir };
    writeFileSync(childrenFile, JSON.stringify({ v: 1, children: [...listed(childrenFile), live] }));
    expect((await launch(fleet, input('twig'))).success).toBe(true);
    expect(listed(childrenFile).filter((c) => c.dataDir === input('leaf').dataDir)).toEqual([
      { name: 'leaf', pid: null, bootId: machineBootId(), dataDir: input('leaf').dataDir },
      live,
    ]);
  });

  test("a fleet that can't read its record keeps the file's children, rather than writing none", async () => {
    const parentData = parentDataDir();
    const childrenFile = childrenFilePath(parentData);
    const earlier = { name: 'earlier', pid: process.pid, bootId: machineBootId(), dataDir: join(parentData, 'earlier') };
    writeFileSync(childrenFile, JSON.stringify({ v: 1, children: [earlier] }));
    const { fleet, input } = await startedFleet({ childrenFile }, { unreadable: true });
    expect((await launch(fleet, input())).success).toBe(true);
    expect(listed(childrenFile).map((c) => c.name)).toEqual(['leaf', 'earlier']);
    expect(listed(childrenFile)[1]).toEqual(earlier);
  });

  test("a children file this release can't read is left as it is, and a launch whose child it can't list fails, saying why", async () => {
    for (const [kind, text] of [['not JSON', 'not json'], ['no list of children', JSON.stringify({ v: 1 })]] as const) {
      const childrenFile = childrenFilePath(parentDataDir());
      writeFileSync(childrenFile, text);
      const { fleet, input } = await startedFleet({ childrenFile });
      const logged = spyOn(console, 'error').mockImplementation(() => {});
      let result: Result;
      try {
        result = await launch(fleet, input());
      } finally {
        logged.mockRestore();
      }
      expect(result.success, kind).toBe(false);
      expect(result.error, kind).toStartWith(`Child 'leaf' didn't start (it couldn't be listed in ${childrenFile}, which an ` +
        'update reads to see which children are running: ');
      expect(result.error, kind).toContain('Replacing it would drop the children it lists, which an update reads to see ' +
        'which may still be running, so every launch fails this way until whoever runs this host fixes it, or removes it ' +
        'once no child it lists is running)');
      expect(readFileSync(childrenFile, 'utf8'), kind).toBe(text);
      expect(fleet.getChildren().get('leaf')?.status, kind).toBe('crashed');
    }
  });

  test("a launch whose child the children file can't list stops the child and fails, saying why", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    // Where the write's temporary file goes, a directory: the write fails,
    // for root as for anyone.
    mkdirSync(`${childrenFile}.tmp`);
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    let result: Result;
    try {
      result = await launch(fleet, input());
    } finally {
      logged.mockRestore();
    }
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(`Child 'leaf' didn't start (it couldn't be listed in ${childrenFile}, which an update ` +
      'reads to see which children are running: EISDIR');
    const child = fleet.getChildren().get('leaf')!;
    expect(child.pid).toBeNumber();
    expect(child.status).toBe('crashed');
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  test("a launch whose record the store can't take stops the child and fails, rather than leaving it running unwatched", async () => {
    const { fleet, input } = await startedFleet();
    const state = (fleet as unknown as { ctx: { setState: (next: Record_) => void } }).ctx;
    const setState = state.setState;
    state.setState = (next) => {
      if (next.children.leaf?.status === 'starting') throw new Error('the store refused the write');
      setState(next);
    };
    const result = await launch(fleet, input());
    expect(result.success).toBe(false);
    expect(result.error).toStartWith("Child 'leaf' didn't start (its record couldn't be kept: the store refused the write)");
    const child = fleet.getChildren().get('leaf')!;
    expect(child.status).toBe('crashed');
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  test("a store that refuses every write gets the launch's failure, and the child's exit is logged, not thrown", async () => {
    const { fleet, input } = await startedFleet();
    (fleet as unknown as { ctx: { setState: () => void } }).ctx.setState = () => { throw new Error('the store refused the write'); };
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    let result: Result;
    try {
      result = await launch(fleet, input());
    } finally {
      log.mockRestore();
    }
    expect(result.success).toBe(false);
    expect(result.error).toStartWith("Child 'leaf' didn't start (its record couldn't be kept: the store refused the write)");
    expect(logged).toContain('[fleet] couldn\'t record that child "leaf" exited: the store refused the write');
  });

  test("a launch whose record can't be synced stops the child and fails", async () => {
    const { fleet, input } = await startedFleet({ childrenFile: childrenFilePath(parentDataDir()) });
    fleet.setStoreSync(() => { throw new Error('the store refused the sync'); });
    const result = await launch(fleet, input());
    expect(result.success).toBe(false);
    expect(result.error).toStartWith("Child 'leaf' didn't start (its record couldn't be kept: the store refused the sync)");
    const child = fleet.getChildren().get('leaf')!;
    expect(child.status).toBe('crashed');
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  test("a later write that fails is logged, the lifecycle goes on, and the file keeps the child's pid", async () => {
    const childrenFile = childrenFilePath(parentDataDir());
    const { fleet, input } = await startedFleet({ childrenFile });
    expect((await launch(fleet, input())).success).toBe(true);
    const pid = fleet.getChildren().get('leaf')!.pid;
    mkdirSync(`${childrenFile}.tmp`);
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    try {
      expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(fleet.getChildren().get('leaf')?.status).not.toBe('ready');
    expect(listed(childrenFile).map((c) => c.pid)).toEqual([pid]);
    expect(logged.some((line) => line.startsWith(`[fleet] couldn't write ${childrenFile}, which an update reads`))).toBe(true);
  });

  test('a fleet the host gave no children file writes and reads none', async () => {
    const write = spyOn(contract, 'writeJsonAtomic');
    const read = spyOn(contract, 'readRecord');
    try {
      const { fleet, dir, input } = await startedFleet();
      expect((await launch(fleet, input())).success).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(readdirSync(dir).filter((name) => name.includes('children'))).toEqual([]);
      expect(existsSync(childrenFilePath(input().dataDir))).toBe(false);
    } finally {
      write.mockRestore();
      read.mockRestore();
    }
  });
});

describe("a fleet child and the install's root", () => {
  test('a child never gets CONNECTOME_INSTALL_ROOT, from the parent or from its own env', async () => {
    process.env.CONNECTOME_INSTALL_ROOT = '/srv/connectome';
    const { fleet, input } = await startedFleet();
    expect((await launch(fleet, {
      ...input(), env: { CONNECTOME_INSTALL_ROOT: '/srv/other', FLEET_TEST_SENTINEL: 'env reached the child' },
    })).success).toBe(true);
    const [row] = readFileSync(join(input().dataDir, 'launches.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(row).toMatchObject({ sentinel: 'env reached the child', installRoot: null });
  });
});
