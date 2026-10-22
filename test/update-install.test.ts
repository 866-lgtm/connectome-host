/**
 * Installing a release beside the running one (src/update/install.ts). Each
 * test builds an install root whose running release holds a package.json,
 * a lockfile and the host, stands in for the package manager with one that
 * writes the host it was asked for, and reads what the install left.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContractError, copyLabelPath, installPaths, moveCurrent, releaseDir, writeJsonAtomic, type CopyLabel, type Mark,
} from '../src/update/contract.js';
import { installRelease, machineInstallOps, type InstallOps } from '../src/update/install.js';
import { HOST_ENTRY, RELEASE_HOST } from '../src/update/launcher.js';

let dir: string;
let root: string;
let said: string[];
let calls: Array<{ manager: string; args: string[]; cwd: string; files: string[] }>;

const here = () => ({ root, release: '0.11.0' });

/** A release in the root, its host at `version`, with the files named beside it. */
function release(name: string, version = name, files: Record<string, string> = {}): string {
  const path = releaseDir(root, name);
  mkdirSync(join(path, RELEASE_HOST, 'src'), { recursive: true });
  writeFileSync(join(path, RELEASE_HOST, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version }));
  writeFileSync(join(path, HOST_ENTRY), '// host\n');
  for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
  return path;
}

/** A package manager that installs the host the last argument asks for,
 *  unless `outcome` says otherwise. */
function manager(outcome: { status?: number | null; output?: string; version?: string; entry?: boolean } = {}): InstallOps {
  return {
    run: async (manager, args, cwd) => {
      calls.push({ manager, args, cwd, files: readdirSync(cwd).sort() });
      const status = outcome.status === undefined ? 0 : outcome.status;
      if (status === 0) {
        const asked = args[args.length - 1]!.replace('@animalabs/connectome-host@', '');
        const host = join(cwd, RELEASE_HOST);
        mkdirSync(join(host, 'src'), { recursive: true });
        writeFileSync(join(host, 'package.json'), JSON.stringify({ version: outcome.version ?? asked }));
        if (outcome.entry !== false) writeFileSync(join(cwd, HOST_ENTRY), '// host\n');
      }
      return { status, output: outcome.output ?? '' };
    },
    report: (line) => { said.push(line); },
  };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'update-install-')));
  root = join(dir, 'connectome-host');
  release('0.11.0', '0.11.0', { 'package.json': '{"dependencies":{"@animalabs/connectome-host":"^0.11.0"}}\n', 'package-lock.json': '{}\n' });
  moveCurrent(root, '0.11.0');
  said = [];
  calls = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const installed = () => readdirSync(installPaths(root).releases).sort();

describe('installing a release beside the running one', () => {
  test('installs the exact version with npm from the running release\'s package.json and lockfile, then renames it in', async () => {
    await installRelease(here(), '0.12.0', manager());
    expect(calls).toEqual([{
      manager: 'npm',
      args: ['install', '--save-exact', '--no-audit', '--no-fund', '@animalabs/connectome-host@0.12.0'],
      cwd: `${releaseDir(root, '0.12.0')}.tmp`,
      files: ['package-lock.json', 'package.json'],
    }]);
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
    expect(JSON.parse(readFileSync(join(releaseDir(root, '0.12.0'), RELEASE_HOST, 'package.json'), 'utf-8')).version).toBe('0.12.0');
    expect(readFileSync(join(releaseDir(root, '0.12.0'), 'package.json'), 'utf-8')).toContain('^0.11.0');
  });

  test('uses bun when the running release holds only a bun lockfile', async () => {
    rmSync(join(releaseDir(root, '0.11.0'), 'package-lock.json'));
    writeFileSync(join(releaseDir(root, '0.11.0'), 'bun.lock'), '{}\n');
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ manager, args, files }) => ({ manager, args, files }))).toEqual([{
      manager: 'bun', args: ['add', '--exact', '@animalabs/connectome-host@0.12.0'], files: ['bun.lock', 'package.json'],
    }]);
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
  });

  test('a binary bun lockfile means bun too', async () => {
    rmSync(join(releaseDir(root, '0.11.0'), 'package-lock.json'));
    writeFileSync(join(releaseDir(root, '0.11.0'), 'bun.lockb'), 'lock');
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ manager, files }) => ({ manager, files }))).toEqual([{ manager: 'bun', files: ['bun.lockb', 'package.json'] }]);
  });

  test('with both lockfiles, npm and its lockfile alone', async () => {
    writeFileSync(join(releaseDir(root, '0.11.0'), 'bun.lock'), '{}\n');
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ manager, files }) => ({ manager, files }))).toEqual([{ manager: 'npm', files: ['package-lock.json', 'package.json'] }]);
  });

  test('with no lockfile, npm from the package.json alone', async () => {
    rmSync(join(releaseDir(root, '0.11.0'), 'package-lock.json'));
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ manager, files }) => ({ manager, files }))).toEqual([{ manager: 'npm', files: ['package.json'] }]);
  });

  test('a manager that fails leaves nothing, and the refusal quotes the command, its exit and the end of its output', async () => {
    const output = `${'x'.repeat(3000)}\nnpm error notarget No matching version found for @animalabs/connectome-host@0.12.0.\n`;
    const error = await installRelease(here(), '0.12.0', manager({ status: 1, output })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    const message = (error as Error).message;
    expect(message).toContain("Installing 0.12.0 failed, so it isn't installed: `npm install --save-exact --no-audit --no-fund " +
      '@animalabs/connectome-host@0.12.0` exited 1. Its output ends:\n…');
    expect(message.endsWith('No matching version found for @animalabs/connectome-host@0.12.0.')).toBe(true);
    expect(message.length).toBeLessThan(2300);
    expect(installed()).toEqual(['0.11.0']);
  });

  test('a manager with no exit status is said so', async () => {
    const error = await installRelease(here(), '0.12.0', manager({ status: null, output: 'Executable not found in $PATH: "npm"' })).catch((e: unknown) => e);
    expect((error as Error).message).toContain('gave no exit status. Its output ends:\nExecutable not found in $PATH: "npm"');
    expect(installed()).toEqual(['0.11.0']);
  });

  test('a host at another version is refused, and nothing is put in place', async () => {
    const error = await installRelease(here(), '0.12.0', manager({ version: '0.12.1' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as Error).message).toBe('Installing 0.12.0 with `npm install --save-exact --no-audit --no-fund ' +
      "@animalabs/connectome-host@0.12.0` didn't give its host, since its host there is 0.12.1, so it isn't installed.");
    expect(installed()).toEqual(['0.11.0']);
  });

  test('a host without its entry is refused', async () => {
    const error = await installRelease(here(), '0.12.0', manager({ entry: false })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as Error).message).toContain(`didn't give its host, since ${HOST_ENTRY} isn't there, so`);
    expect(installed()).toEqual(['0.11.0']);
  });

  test('a release already in place is kept, and nothing is installed', async () => {
    release('0.12.0');
    await installRelease(here(), '0.12.0', manager());
    expect(calls).toEqual([]);
    expect(said).toEqual([`[update] 0.12.0 is already installed in ${releaseDir(root, '0.12.0')}, so it isn't installed again.`]);
  });

  test('refuses a version that isn\'t exact, and the release running, before anything', async () => {
    for (const version of ['latest', '^0.12.0', '0.12', '0.12.0+build', '../0.12.0', '0.12.0 ']) {
      const error = await installRelease(here(), version, manager()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ContractError);
      expect((error as Error).message).toBe(`${JSON.stringify(version)} isn't an exact version of @animalabs/connectome-host, such as 0.12.0.`);
    }
    const running = await installRelease(here(), '0.11.0', manager()).catch((e: unknown) => e);
    expect((running as Error).message).toBe('This host already runs 0.11.0.');
    expect(calls).toEqual([]);
    expect(installed()).toEqual(['0.11.0']);
  });

  test('syncs the release before its rename, and the releases directory after', async () => {
    const paths = new Map<number, string>();
    const steps: string[] = [];
    const realOpen = fs.openSync;
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    const opens = spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      const fd = (realOpen as (...args: unknown[]) => number)(path, ...rest);
      paths.set(fd, String(path));
      return fd;
    }) as typeof fs.openSync);
    const syncs = spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      steps.push(`sync ${paths.get(fd) ?? fd}`);
      realFsync(fd);
    }) as typeof fs.fsyncSync);
    const renames = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      steps.push(`rename ${from}`);
      realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      await installRelease(here(), '0.12.0', manager());
    } finally {
      opens.mockRestore();
      syncs.mockRestore();
      renames.mockRestore();
    }
    const tmp = `${releaseDir(root, '0.12.0')}.tmp`;
    expect(steps).toEqual([`sync ${tmp}`, `rename ${tmp}`, `sync ${installPaths(root).releases}`]);
  });

  test('takes a prerelease', async () => {
    await installRelease(here(), '0.13.0-rc.1', manager());
    expect(installed()).toEqual(['0.11.0', '0.13.0-rc.1']);
  });

  test('runs one install at a time', async () => {
    let finish!: () => void;
    const slow = manager();
    const run = slow.run;
    slow.run = async (...args) => { await new Promise<void>((done) => { finish = done; }); return run(...args); };
    const first = installRelease(here(), '0.12.0', slow);
    await Bun.sleep(10);
    const second = await installRelease(here(), '0.12.1', manager()).catch((e: unknown) => e);
    expect((second as Error).message).toBe('An install of 0.12.0 is under way. Wait for it to end, then ask again.');
    finish();
    await first;
    await installRelease(here(), '0.12.1', manager());
    // 0.12.0 went, since no mark asks for it.
    expect(installed()).toEqual(['0.11.0', '0.12.1']);
  });

  test('an install that failed doesn\'t hold the next one back', async () => {
    await installRelease(here(), '0.12.0', manager({ status: 1 })).catch(() => {});
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
  });
});

describe('removing releases nothing needs', () => {
  function copyFrom(from: string): void {
    const { copy } = installPaths(root);
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, '0-data'), '');
    writeJsonAtomic(copyLabelPath(copy), { v: 1, from, at: new Date().toISOString(), items: [{ path: '/srv/data', name: '0-data' }] } satisfies CopyLabel);
  }

  test('keeps current, the running release, the copy\'s, the mark\'s and the one being installed; removes the rest and cut installs', async () => {
    for (const name of ['0.9.0', '0.10.0', '0.10.2', '0.13.0']) release(name);
    mkdirSync(join(installPaths(root).releases, 'notes'));
    mkdirSync(join(installPaths(root).releases, '0.12.0.tmp', 'node_modules'), { recursive: true });
    // A removal of 0.10.0 cut short, beside the release itself.
    mkdirSync(join(installPaths(root).releases, '0.10.0.tmp', 'node_modules'), { recursive: true });
    copyFrom('0.10.2');
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'b9c3a1de-0000-4000-8000-000000000000', to: '0.13.0', why: 'update', at: new Date().toISOString() } satisfies Mark);
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.10.2', '0.11.0', '0.12.0', '0.13.0', 'notes']);
    expect(said).toEqual([]);
  });

  test('keeps the running release when current names another, as on a trial', async () => {
    release('0.10.2');
    moveCurrent(root, '0.10.2');
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.10.2', '0.11.0', '0.12.0']);
  });

  test('removes nothing when the copy\'s label can\'t be read, and still installs', async () => {
    release('0.9.0');
    copyFrom('0.10.2');
    writeFileSync(copyLabelPath(installPaths(root).copy), '{"v":1,"from":"0.10.2","items":[]}');
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0']);
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith("[update] No older release is removed this time: which releases a Go back or a request needs can't be told (The copy's label at ");
  });

  test('removes nothing when the mark can\'t be used', async () => {
    release('0.9.0');
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: '../x', to: '0.13.0', why: 'update', at: new Date().toISOString() });
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0']);
    expect(said[0]).toContain('No older release is removed this time');
  });

  test('a release that can\'t be removed is reported and never taken for a release, and the next install removes it', async () => {
    release('0.9.0');
    release('0.10.0');
    const stuck = `${releaseDir(root, '0.9.0')}.tmp`;
    const rmdir = fs.rmdirSync;
    const spy = spyOn(fs, 'rmdirSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === stuck) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${stuck}'`), { code: 'EBUSY' });
      return (rmdir as (...a: unknown[]) => void)(path, ...rest);
    }) as typeof fs.rmdirSync);
    try {
      await installRelease(here(), '0.12.0', manager());
    } finally {
      spy.mockRestore();
    }
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0.tmp']);
    expect(said).toEqual([`[update] ${releaseDir(root, '0.9.0')}, which nothing needs, couldn't be removed, and the next ` +
      `install tries again: EBUSY: resource busy or locked, rmdir '${stuck}'`]);
    // What the removal left isn't a release, so installing 0.9.0 installs it whole.
    await installRelease(here(), '0.9.0', manager());
    expect(calls.map(({ cwd }) => cwd)).toEqual([`${releaseDir(root, '0.12.0')}.tmp`, stuck]);
    expect(installed()).toEqual(['0.11.0', '0.9.0']);
  });

  test('a release that can\'t be renamed aside stays whole, and the install goes on', async () => {
    release('0.9.0');
    const rename = fs.renameSync;
    const spy = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === releaseDir(root, '0.9.0')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return rename(from, to);
    }) as typeof fs.renameSync);
    try {
      await installRelease(here(), '0.12.0', manager());
    } finally {
      spy.mockRestore();
    }
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0']);
    expect(existsSync(join(releaseDir(root, '0.9.0'), HOST_ENTRY))).toBe(true);
    expect(said).toEqual([`[update] ${releaseDir(root, '0.9.0')}, which nothing needs, couldn't be removed, and the next ` +
      'install tries again: EACCES: permission denied']);
  });
});

describe('the machine\'s package manager', () => {
  /** Run `body` with a PATH that finds nothing, so only what the ops find
   *  without it can start. */
  async function withoutPath(body: () => Promise<void>): Promise<void> {
    const path = process.env.PATH;
    process.env.PATH = join(dir, 'nothing-here');
    try {
      await body();
    } finally {
      process.env.PATH = path;
    }
  }

  test('runs the Bun running this host, and gives its exit status and the end of its output', async () => {
    const ops = machineInstallOps();
    await withoutPath(async () => {
      const ran = await ops.run('bun', ['-e', 'process.stdout.write("a".repeat(9000) + "end"); process.exit(3)'], dir);
      expect(ran.status).toBe(3);
      expect(ran.output.length).toBe(4000);
      expect(ran.output.endsWith('aend')).toBe(true);
      const version = await ops.run('bun', ['--version'], dir);
      expect(version).toEqual({ status: 0, output: `${Bun.version}\n` });
    });
  });

  test('one that can\'t start says why', async () => {
    await withoutPath(async () => {
      const ran = await machineInstallOps().run('npm', ['--version'], dir);
      expect(ran).toEqual({ status: null, output: 'Executable not found in $PATH: "npm"' });
    });
  });
});
