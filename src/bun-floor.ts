/**
 * The warning a host prints at start when the Bun running it is below the
 * floor its package.json declares (`engines.bun`). Below that floor the host
 * can fail in ways that don't name Bun, such as an EFAULT from a filesystem
 * call, so the warning names it first. It warns rather than refuses, and
 * nothing else depends on it.
 *
 * Pure, for its test: `engines` is the package.json's field, `bun` the running
 * Bun's version, and `satisfies` Bun's own semver check.
 */
export function bunFloorWarning(
  engines: unknown,
  bun: string | undefined,
  hostVersion: string | undefined,
  satisfies: ((version: string, range: string) => boolean) | undefined,
): string | null {
  const range = engines !== null && typeof engines === 'object' ? (engines as { bun?: unknown }).bun : undefined;
  if (typeof range !== 'string' || !bun || !satisfies) return null;
  // A canary build compares by its release numbers: semver puts a
  // prerelease such as 1.5.0-canary.1 below >=1.4.3.
  const release = bun.split(/[-+]/)[0]!;
  if (satisfies(release, range)) return null;
  const host = hostVersion ? `connectome-host ${hostVersion}` : 'connectome-host';
  return `[host] ${host} needs Bun ${range} (engines.bun in its package.json), and this is Bun ${bun}. ` +
    'Below that it can fail in ways that don\'t name Bun. Upgrade Bun (`bun upgrade`) and start the host again.';
}
