import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bunFloorWarning } from '../src/bun-floor.js';
import { HOST_PACKAGE_JSON, checkBunFloor } from '../src/bun-floor-check.js';

const engines = { node: '>=22.12.0', bun: '>=1.4.3' };
const warned = (bun: string) => bunFloorWarning(engines, bun, '0.10.2') !== null;

describe('the start-up warning for a Bun below the floor', () => {
  test('a Bun below the floor is named, with the floor and who acts', () => {
    expect(bunFloorWarning(engines, '1.3.14', '0.10.2')).toBe(
      '[host] connectome-host 0.10.2 needs Bun >=1.4.3 (engines.bun in its package.json), and this is Bun 1.3.14. '
        + "Below that it can fail in ways that don't name Bun. Whoever runs this host can upgrade Bun, "
        + 'with `bun upgrade` or the package manager that installed it, and start the host again.',
    );
    expect(bunFloorWarning(engines, '1.4.2', undefined)).toContain('[host] connectome-host needs Bun >=1.4.3');
  });

  test('versions compare by their release numbers, a prerelease coming before its own release', () => {
    for (const bun of ['1.3.14', '1.4.2', '0.9.9', '1.4.3-canary.1', '1.4.3-canary.1+abc123', '1.4.2+abc']) {
      expect({ bun, warned: warned(bun) }).toEqual({ bun, warned: true });
    }
    for (const bun of ['1.4.3', '1.4.4', '1.5.0', '2.0.0', '1.4.3+abc', '1.5.0-canary.1+abc123', '1.4.4-canary.2']) {
      expect({ bun, warned: warned(bun) }).toEqual({ bun, warned: false });
    }
  });

  test('the floor is read only as a string >=X.Y.Z, with or without spaces', () => {
    expect(bunFloorWarning({ bun: ' >= 1.4.3 ' }, '1.3.14', '0.10.2')).toContain('needs Bun >= 1.4.3 (engines.bun');
    // The last two aren't strings: String() would read the array as a floor,
    // and throw on the object.
    for (const bun of ['^1.4.3', '1.4.3', '>=1.4', '>=1.4.3 <2', '>1.4.3', '', 7, null, ['>=1.4.3'], JSON.parse('{"toString":null}')]) {
      expect({ bun, warning: bunFloorWarning({ bun }, '1.3.14', '0.10.2') }).toEqual({ bun, warning: null });
    }
  });

  test('no engines, or no running Bun, gives none', () => {
    for (const e of [undefined, null, 'x', { node: '>=22' }]) {
      expect({ e, warning: bunFloorWarning(e, '1.3.14', '0.10.2') }).toEqual({ e, warning: null });
    }
    expect(bunFloorWarning(engines, undefined, '0.10.2')).toBeNull();
    expect(bunFloorWarning(engines, 'not a version', '0.10.2')).toBeNull();
  });

  test("the host's own package.json declares a floor the check reads", () => {
    const pkg = JSON.parse(readFileSync(HOST_PACKAGE_JSON, 'utf-8'));
    expect(pkg.name).toBe('@animalabs/connectome-host');
    expect(pkg.engines.bun).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(bunFloorWarning(pkg.engines, '0.0.1', pkg.version)).not.toBeNull();
  });

  test('the host imports the check before anything else runs', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
    // Only whitespace and comments come before it. A `//` comment is taken
    // whole, to its line's end, so an import commented out doesn't count.
    expect(index).toMatch(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*import '\.\/bun-floor-check\.js';/);
  });
});

describe('the check at start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bun-floor-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const pkgAt = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    return pathToFileURL(join(dir, name));
  };

  test("prints the warning for a package.json whose floor this Bun is below, naming this Bun", () => {
    const lines: string[] = [];
    const pkg = pkgAt('above.json', JSON.stringify({ version: '9.9.9', engines: { bun: '>=99.0.0' } }));
    const notice = checkBunFloor(pkg, (line) => lines.push(line));
    expect(lines).toEqual([notice!]);
    expect(notice).toStartWith(`[host] connectome-host 9.9.9 needs Bun >=99.0.0 (engines.bun in its package.json), and this is Bun ${process.versions.bun}.`);
  });

  test('prints nothing when this Bun meets the floor, or the package.json is missing or not JSON', () => {
    const lines: string[] = [];
    const warn = (line: string) => lines.push(line);
    expect(checkBunFloor(pkgAt('met.json', JSON.stringify({ engines: { bun: '>=0.0.1' } })), warn)).toBeNull();
    expect(checkBunFloor(pathToFileURL(join(dir, 'missing.json')), warn)).toBeNull();
    expect(checkBunFloor(pkgAt('torn.json', '{ "engines": '), warn)).toBeNull();
    expect(checkBunFloor(pkgAt('null.json', 'null'), warn)).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe('a TUI start under a Bun below the floor', () => {
  // test/mock-tui-bun-floor-child.ts gives the check Bun 1.3.14 before it
  // loads, and starts runTui with a saved session longer than its view.
  test("prints the warning once as the check loads, and the TUI's first view shows it below the history", async () => {
    const pkg = JSON.parse(readFileSync(HOST_PACKAGE_JSON, 'utf-8'));
    const expected = bunFloorWarning(pkg.engines, '1.3.14', pkg.version)!;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bun-floor-tui-')));
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'mock-tui-bun-floor-child.ts'), '1.3.14'], {
        cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stdout).not.toContain('TUI_ERROR');
      expect(code).toBe(0);
      // The check's own call at load, with its defaults: the host's
      // package.json, and console.warn to stderr.
      expect(stderr.split('\n').filter(line => line.startsWith('[host] '))).toEqual([expected]);
      const frame: string = JSON.parse(stdout.match(/TUI_FRAME ([^\n]*)/)![1]!);
      // The view keeps to its bottom: the history's start is out of sight,
      // and the warning, wrapped, is in it.
      expect(frame).not.toContain('history 01');
      expect(frame).toContain(`[host] connectome-host ${pkg.version} needs Bun ${pkg.engines.bun} (engines.bun`);
      expect(frame).toContain('start the host again.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
