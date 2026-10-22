/**
 * Installing a release beside the running one (contract.ts): the step of an
 * update that the host's Update takes while everything keeps running. It
 * installs one exact version of the package as `releases/<version>`, so the
 * release is there whole or isn't there at all, and writes no mark: Update
 * writes the mark once this returns.
 *
 * Which version to install is Update's to decide, from the registry's
 * manifest of it: Update refuses a release deprecated on npm, one no newer
 * than the running one, and one whose Bun floor is above the Bun running this
 * host, before it calls this.
 *
 * Only a host started through the install's entry point calls it, and that
 * host holds the install's lock while it runs (takeLock), so neither a
 * launcher nor another host writes `releases/` meanwhile. Within the host,
 * one install runs at a time.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ContractError, installPaths, lastCopy, readCurrent, readMark, releaseDir } from './contract.js';
import { removeTree, syncPath } from './data-swap.js';
import type { ReleaseHere } from './host.js';
import { HOST_ENTRY, LAUNCHER, RELEASE_HOST } from './launcher.js';

export const PACKAGE = '@animalabs/connectome-host';

/** An exact version as npm publishes one: release numbers, then any prerelease. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The suffix of the install's own unfinished work in `releases/`: an install
 *  under way, and a release renamed aside for its removal. */
const WORKING = '.tmp';

/** The lockfiles a release may hold, each with the manager that writes it, in
 *  the order one is chosen when a release holds several. */
const LOCKFILES: Array<{ name: string; manager: 'npm' | 'bun' }> = [
  { name: 'package-lock.json', manager: 'npm' },
  { name: 'bun.lock', manager: 'bun' },
  { name: 'bun.lockb', manager: 'bun' },
];

/** How much of a failed manager's output a refusal quotes, from its end. */
const OUTPUT_TAIL = 2000;

/** What installing needs from the machine, given to it so tests can stand in. */
export interface InstallOps {
  /** Run a package manager, `npm` or `bun`, with `args` in `cwd`: its exit
   *  status, null when it couldn't start or ended on a signal, and its
   *  output, both streams. */
  run(manager: 'npm' | 'bun', args: string[], cwd: string): Promise<{ status: number | null; output: string }>;
  /** A line for the operator, in the host's log. */
  report(line: string): void;
}

/** The version an install of which is under way in this process. */
let underWay: string | null = null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Install `version` as `releases/<version>`, beside the release `here` runs.
 * A ContractError says why the release isn't installed. Anything else thrown
 * is the filesystem's own error, and the release isn't installed then
 * either, except when the last sync of `releases/` failed: the release is in
 * place, and a retry reuses it and makes that sync again.
 */
export async function installRelease(here: ReleaseHere, version: string, ops: InstallOps = machineInstallOps()): Promise<void> {
  if (!EXACT.test(version)) {
    throw new ContractError(`${JSON.stringify(version)} isn't an exact version of ${PACKAGE}, such as 0.12.0.`);
  }
  if (version.endsWith(WORKING)) {
    throw new ContractError(`${version} ends in ${WORKING}, which names the install's own unfinished work in ` +
      'releases/, so it can\'t be installed here.');
  }
  if (version === here.release) throw new ContractError(`This host already runs ${version}.`);
  if (underWay !== null) {
    throw new ContractError(`An install of ${underWay} is under way. Wait for it to end, or restart the host to end ` +
      'one that hangs, then ask again.');
  }
  underWay = version;
  try {
    const { releases } = installPaths(here.root);
    const release = releaseDir(here.root, version);
    prune(here, version, ops);
    if (existsSync(release)) {
      const problem = hostProblem(release, version);
      if (problem !== null) {
        throw new ContractError(`${release} is there, but ${problem}, so it isn't the release ${version}. Remove it, ` +
          'then update again.');
      }
      ops.report(`[update] ${version} is already installed in ${release}, so it isn't installed again.`);
    } else {
      const tmp = `${release}${WORKING}`;
      try {
        mkdirSync(tmp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new ContractError(`${tmp}, which an earlier install of ${version} left, couldn't be removed, so ` +
          `${version} can't be installed. Remove it, then update again.`);
      }
      try {
        await installInto(tmp, releaseDir(here.root, here.release), version, ops);
        syncTree(tmp);
        renameSync(tmp, release);
      } catch (error) {
        try {
          removeTree(tmp);
        } catch (removal) {
          ops.report(`[update] ${tmp}, the install that failed, couldn't be removed, and the next install removes it: ` +
            errorText(removal));
        }
        throw error;
      }
    }
    // After a reuse too, so a retry makes the sync a failed call didn't.
    syncPath(releases);
  } finally {
    underWay = null;
  }
}

/** Install `version` in `tmp` from the running release's package.json and
 *  lockfile with the manager that wrote the lockfile, as an operator updating
 *  by hand would (docs/DEPLOYMENTS.md, "Updating an install"), so the
 *  operator's other packages keep their locked versions when the release has
 *  a lockfile. Then check that the host is in place at `version`. */
async function installInto(tmp: string, running: string, version: string, ops: InstallOps): Promise<void> {
  const lock = LOCKFILES.find(({ name }) => existsSync(join(running, name)));
  copyFileSync(join(running, 'package.json'), join(tmp, 'package.json'));
  if (lock) copyFileSync(join(running, lock.name), join(tmp, lock.name));
  const manager = lock?.manager ?? 'npm';
  const args = manager === 'npm'
    ? ['install', '--save-exact', '--no-audit', '--no-fund', `${PACKAGE}@${version}`]
    : ['add', '--exact', `${PACKAGE}@${version}`];
  const { status, output } = await ops.run(manager, args, tmp);
  const command = `${manager} ${args.join(' ')}`;
  if (status !== 0) {
    const tail = output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output;
    const how = status !== null ? `exited ${status}`
      : 'gave no exit status, so it couldn\'t start or was stopped' +
        (manager === 'npm' ? ' (if npm isn\'t on the PATH the host runs with, give its service a PATH that has it)' : '');
    throw new ContractError(`Installing ${version} failed, so it isn't installed: \`${command}\` ${how}. Its output ` +
      `ends:\n${tail.trimEnd()}`);
  }
  const problem = hostProblem(tmp, version);
  if (problem !== null) {
    throw new ContractError(`Installing ${version} with \`${command}\` didn't put its host in place: ${problem}, so it ` +
      "isn't installed.");
  }
}

/** What keeps the host in `dir`, a release's directory, from being `version`'s,
 *  or null when nothing does: its package.json says `version`, and its entry
 *  and its launcher, which a switch imports (checkRelease), are there. */
function hostProblem(dir: string, version: string): string | null {
  const manifest = join(dir, RELEASE_HOST, 'package.json');
  let installed: unknown;
  try {
    installed = (JSON.parse(readFileSync(manifest, 'utf-8')) as { version?: unknown } | null)?.version;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${manifest} isn't there`
      : `${manifest} can't be read (${errorText(error)})`;
  }
  if (installed !== version) {
    return typeof installed === 'string' ? `its host is ${installed}` : `${manifest} names no version`;
  }
  for (const file of [HOST_ENTRY, LAUNCHER]) {
    if (!existsSync(join(dir, file))) return `${join(dir, file)} isn't there`;
  }
  return null;
}

/** Sync each file and directory under `dir`, and `dir` last, so a rename of
 *  `dir` can't outlive on disk what it holds, as setup's copy of its first
 *  release does (copyTree). A link is synced as its directory's entry. */
function syncTree(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) syncTree(path);
    else if (entry.isFile()) syncPath(path);
  }
  syncPath(dir);
}

/** Remove what installs cut off left, and each release nothing names. After
 *  a switch, releases/ then holds the running release, the one a Go back
 *  returns to, and, until the next install removes it, the one before that.
 *
 *  It keeps the release `current` names, the running one, the one the copy
 *  holds the data of, which a Go back returns to, the one a standing mark
 *  asks for, and the one being installed. A release is removed only when
 *  `current` and the copy's label are both there to say what a start and a
 *  Go back need: a labelled copy is there from an install's first switch on,
 *  so without one there has been no switch yet, or something has damaged
 *  it, and either way only what cut installs left is removed. A name ending
 *  in `.tmp` is never a release's (installRelease refuses one), so that is
 *  what an install or a removal cut off left. A release is renamed to one
 *  before its removal, and the rename synced, so a removal cut short never
 *  leaves part of a release under its own name. A removal that fails is
 *  reported, and the install goes on, since nothing needs what it would have
 *  removed. Anything else in `releases/`, which nothing the update does puts
 *  there, is left alone. */
function prune(here: ReleaseHere, version: string, ops: InstallOps): void {
  const { releases } = installPaths(here.root);
  const keep = new Set([here.release, version]);
  let known = false;
  try {
    const current = readCurrent(here.root);
    const label = lastCopy(here.root);
    for (const name of [current, label?.from, readMark(here.root)?.to]) {
      if (typeof name === 'string') keep.add(name);
    }
    known = current !== null && label !== null;
  } catch (error) {
    ops.report(`[update] No older release is removed this time: which releases a start, a Go back or a request ` +
      `needs can't be told (${errorText(error)}).`);
  }
  let names: string[];
  try {
    names = readdirSync(releases);
  } catch (error) {
    ops.report(`[update] Nothing in ${releases} is removed this time: it can't be listed (${errorText(error)}).`);
    return;
  }
  // What cuts left first, so a release's rename aside doesn't meet it.
  const cut = names.filter((name) => name.endsWith(WORKING) && !keep.has(name));
  const unneeded = known ? names.filter((name) => !name.endsWith(WORKING) && !keep.has(name) &&
    existsSync(join(releases, name, HOST_ENTRY))) : [];
  for (const name of [...cut, ...unneeded]) {
    const path = join(releases, name);
    try {
      if (name.endsWith(WORKING)) {
        removeTree(path);
      } else {
        renameSync(path, `${path}${WORKING}`);
        syncPath(releases);
        removeTree(`${path}${WORKING}`);
      }
    } catch (error) {
      ops.report(`[update] ${path}, which nothing needs, couldn't be removed, and the next install tries again: ` +
        errorText(error));
    }
  }
}

export function machineInstallOps(): InstallOps {
  return {
    run: (manager, args, cwd) => new Promise((done) => {
      let output = '';
      const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2 * OUTPUT_TAIL); };
      // The Bun running this host, rather than whichever is first on PATH.
      const child = spawn(manager === 'bun' ? process.execPath : 'npm', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('error', (error) => { done({ status: null, output: `${output}${errorText(error)}` }); });
      child.on('close', (status) => { done({ status, output }); });
    }),
    report: (text) => { writeSync(2, `${text}\n`); },
  };
}
