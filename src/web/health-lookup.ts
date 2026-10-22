/**
 * The Web UI's health panel reads the /healthz snapshot through this, which
 * the server's tests can reach (the panel imports it as
 * `@conhost/web/health-lookup`).
 */

/**
 * The entry under `key` in one of the snapshot's maps, such as an agent's
 * entry in a per-agent section, or a section in an agent's readFailures.
 * The maps come from JSON.parse, so they have Object.prototype: this reads
 * an own key only, so an agent named `constructor` or `__proto__` that's
 * missing from a section reads as missing. A missing or null map has no
 * entries.
 */
export function healthEntry<T>(map: Record<string, T> | null | undefined, key: string): T | undefined {
  return map != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** The panel's line for a section an agent's read failed for, with what the
 *  error said when the snapshot carries it: an observer without 'ops' gets
 *  it empty. */
export function readFailureLine(section: string, message: string): string {
  return message ? `${section} couldn't be read: ${message}` : `${section} couldn't be read`;
}
