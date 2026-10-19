import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bunFloorWarning } from '../src/bun-floor.js';

const satisfies = (version: string, range: string): boolean => Bun.semver.satisfies(version, range);
const engines = { node: '>=22.12.0', bun: '>=1.4.3' };

describe('the start-up warning for a Bun below the floor', () => {
  test('a Bun below the floor is named, with the floor and what to do', () => {
    expect(bunFloorWarning(engines, '1.3.14', '0.10.2', satisfies)).toBe(
      '[host] connectome-host 0.10.2 needs Bun >=1.4.3 (engines.bun in its package.json), and this is Bun 1.3.14. '
        + 'Below that it can fail in ways that don\'t name Bun. Upgrade Bun (`bun upgrade`) and start the host again.',
    );
    expect(bunFloorWarning(engines, '1.4.2', undefined, satisfies)).toContain('[host] connectome-host needs Bun >=1.4.3');
  });

  test('a Bun at or above the floor, a canary of a later release included, gets none', () => {
    for (const bun of ['1.4.3', '1.4.4', '1.5.0', '1.5.0-canary.1+abc123']) {
      expect({ bun, warning: bunFloorWarning(engines, bun, '0.10.2', satisfies) }).toEqual({ bun, warning: null });
    }
  });

  test('no floor, no Bun, or a floor Bun reads as no limit, gives none', () => {
    expect(bunFloorWarning(undefined, '1.3.14', '0.10.2', satisfies)).toBeNull();
    expect(bunFloorWarning({ node: '>=22' }, '1.3.14', '0.10.2', satisfies)).toBeNull();
    expect(bunFloorWarning({ bun: '' }, '1.3.14', '0.10.2', satisfies)).toBeNull();
    expect(bunFloorWarning({ bun: 7 }, '1.3.14', '0.10.2', satisfies)).toBeNull();
    expect(bunFloorWarning(engines, undefined, '0.10.2', satisfies)).toBeNull();
    expect(bunFloorWarning(engines, '1.3.14', '0.10.2', undefined)).toBeNull();
    // Bun's semver takes a range it can't parse as no limit.
    expect(bunFloorWarning({ bun: 'garbage' }, '1.3.14', '0.10.2', satisfies)).toBeNull();
  });

  test('the host imports the check before anything else', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
    const firstImport = index.split('\n').find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './bun-floor-check.js';");
  });
});
