/**
 * Warns at start when this Bun is below the host's floor (see bun-floor.ts).
 * src/index.ts imports it first, so the warning prints before the modules
 * imported after it run, whose failures on an older Bun may not name Bun.
 */
import { readFileSync } from 'node:fs';
import { bunFloorWarning } from './bun-floor.js';

try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version?: unknown;
    engines?: unknown;
  };
  const warning = bunFloorWarning(
    pkg.engines,
    process.versions.bun,
    typeof pkg.version === 'string' ? pkg.version : undefined,
    typeof Bun === 'undefined' ? undefined : (version, range) => Bun.semver.satisfies(version, range),
  );
  if (warning) console.warn(warning);
} catch {
  // A package.json that can't be read changes nothing about starting.
}
