/**
 * Installing a release beside the running one (contract.ts): the step of an
 * update that the host's Update takes while everything keeps running. It
 * installs one exact version of the package as `releases/<version>`, so the
 * release is there whole or nothing has changed, and writes no mark: Update
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
import { HOST_ENTRY, RELEASE_HOST } from './launcher.js';

export const PACKAGE = '@animalabs/connectome-host';

/** An exact version as npm publishes one: release numbers, then any prerelease. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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
 * A ContractError says why nothing was installed; anything else thrown is the
 * filesystem's own error, after which nothing is in place either.
 */
export async function installRelease(here: ReleaseHere, version: string, ops: InstallOps = machineInstallOps()): Promise<void> {
  if (!EXACT.test(version)) {
    throw new ContractError(`${JSON.stringify(version)} isn't an exact version of ${PACKAGE}, such as 0.12.0.`);
  }
  if (version === here.release) throw new ContractError(`This host already runs ${version}.`);
  if (underWay !== null) {
    throw new ContractError(`An install of ${underWay} is under way. Wait for it to end, then ask again.`);
  }
  underWay = version;
  try {
    const release = releaseDir(here.root, version);
    prune(here, version, ops);
    if (existsSync(release)) {
      // A release comes into releases/ only by the rename of a whole one, here
      // or in setup, and leaves it by a rename before its removal (prune).
      ops.report(`[update] ${version} is already installed in ${release}, so it isn't installed again.`);
      return;
    }
    const tmp = `${release}.tmp`;
    mkdirSync(tmp);
    try {
      await installInto(tmp, releaseDir(here.root, here.release), version, ops);
      syncPath(tmp);
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
    syncPath(installPaths(here.root).releases);
  } finally {
    underWay = null;
  }
}

/** Install `version` in `tmp` from the running release's package.json and
 *  lockfile with the manager that wrote the lockfile, as an operator updating
 *  by hand would (docs/DEPLOYMENTS.md, "Updating an install"), so the
 *  operator's other packages keep their locked versions. Then check that the
 *  host is there at `version`. */
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
    throw new ContractError(`Installing ${version} failed, so it isn't installed: \`${command}\` ` +
      `${status === null ? 'gave no exit status' : `exited ${status}`}. Its output ends:\n${tail.trimEnd()}`);
  }
  let installed: unknown;
  try {
    installed = (JSON.parse(readFileSync(join(tmp, RELEASE_HOST, 'package.json'), 'utf-8')) as { version?: unknown }).version;
  } catch {
    installed = undefined;
  }
  const missing = installed !== version
    ? typeof installed === 'string' ? `its host there is ${installed}` : `${join(RELEASE_HOST, 'package.json')} names no version`
    : !existsSync(join(tmp, HOST_ENTRY)) ? `${HOST_ENTRY} isn't there` : null;
  if (missing !== null) {
    throw new ContractError(`Installing ${version} with \`${command}\` didn't give its host, since ${missing}, so it ` +
      "isn't installed.");
  }
}

/** Remove each release nothing names, and what installs cut off left, so an
 *  install holds the running release and the one a Go back would return to,
 *  and the one before that until the next install. It keeps the release
 *  `current` names, the running one, the one the copy holds the data of,
 *  which a Go back returns to, the one a standing mark asks for, and the one
 *  being installed. When those can't be read, it removes nothing. A release
 *  is renamed to a `.tmp` before its removal, so one that a failed removal
 *  cut short is never taken for a release, and a release that's there is
 *  whole. A removal that fails is reported, and the install goes on, since
 *  nothing needs what it would have removed. Anything in `releases/` that
 *  isn't a release or a `.tmp` is left alone. */
function prune(here: ReleaseHere, version: string, ops: InstallOps): void {
  const { releases } = installPaths(here.root);
  const keep = new Set([here.release, version]);
  try {
    for (const name of [readCurrent(here.root), lastCopy(here.root)?.from, readMark(here.root)?.to]) {
      if (typeof name === 'string') keep.add(name);
    }
  } catch (error) {
    ops.report(`[update] No older release is removed this time: which releases a Go back or a request needs ` +
      `can't be told (${errorText(error)}).`);
    return;
  }
  let names: string[];
  try {
    names = readdirSync(releases);
  } catch (error) {
    ops.report(`[update] No older release is removed this time: ${releases} can't be listed (${errorText(error)}).`);
    return;
  }
  // The .tmp entries first, so a release's rename doesn't meet one.
  const cut = names.filter((name) => name.endsWith('.tmp'));
  const unneeded = names.filter((name) => !name.endsWith('.tmp') && !keep.has(name) &&
    existsSync(join(releases, name, HOST_ENTRY)));
  for (const name of [...cut, ...unneeded]) {
    const path = join(releases, name);
    try {
      const doomed = name.endsWith('.tmp') ? path : `${path}.tmp`;
      if (doomed !== path) renameSync(path, doomed);
      removeTree(doomed);
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
