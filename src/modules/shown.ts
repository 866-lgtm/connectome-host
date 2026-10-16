/** A value as a refusal quotes it to the agent: as JSON, except a number
 *  JSON can't hold (a JSON 1e400 parses as Infinity), which JSON.stringify
 *  would show as null. */
export function shown(value: unknown): string {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value) ?? String(value);
}
