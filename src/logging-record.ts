// Serializes one llm-calls record to its JSONL line. Shared by the three
// writers: the generic decorator (logging-provider-wrapper.ts) and the
// Anthropic and Bedrock subclasses (logging-adapter.ts,
// logging-bedrock-adapter.ts), so the size guard has one owner.
//
// Every line, its newline included, stays within MAX_RECORD_BYTES of UTF-8.
// A record that fits is written exactly as JSON.stringify gives it. One over
// the cap, or one that can't be serialized (a cycle or a BigInt), loses parts
// in a fixed order, each step checked against the cap again: first the raw
// bodies, then everything but the head and the error, and last everything
// but the head's and the classification's scalar values, each text cut to a
// bound. `truncated` states which step the line came from. The record itself
// is never changed: observers and the call ledger read it, not the line.
//
// Serializing never throws; each writer still guards its own append.

import { Buffer } from 'node:buffer';
import { boundText } from './logging-error-fields.js';

/** Most UTF-8 bytes one line may take, its newline included. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** The head and the error: what a record keeps when even its summaries are
 *  too big or can't be serialized. */
const HEAD_AND_ERROR = ['type', 'provider', 'kind', 'timestamp', 'durationMs', 'keepalive', 'error', 'errorType',
  'httpStatus', 'providerErrorCode', 'retryable', 'errorChars', 'summaryUnavailable'];

/** Longest text the last fallback keeps of any one field. */
const MAX_LAST_RESORT_CHARS = 1_024;

/** Whether `line` and its newline fit the cap. A UTF-16 unit takes one to
 *  three UTF-8 bytes, so only a line near the cap needs counting. */
function fits(line: string): boolean {
  if (line.length * 3 + 1 <= MAX_RECORD_BYTES) return true;
  if (line.length + 1 > MAX_RECORD_BYTES) return false;
  return Buffer.byteLength(line, 'utf8') + 1 <= MAX_RECORD_BYTES;
}

/** JSON.stringify, giving undefined where it throws. */
function stringify(value: unknown): string | undefined {
  try { return JSON.stringify(value); } catch { return undefined; }
}

/** The record's `keys` that it has, each read on its own: a field that can't
 *  be read is left out and costs only itself. */
function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    try {
      if (key in record) kept[key] = record[key];
    } catch { /* an unreadable field costs only itself */ }
  }
  return kept;
}

/** The head's and the classification's strings, numbers and booleans, each
 *  text cut to MAX_LAST_RESORT_CHARS. At most a few dozen KB, so it always
 *  fits, and building it can't throw. */
function lastResort(record: Record<string, unknown>): string {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pick(record, HEAD_AND_ERROR))) {
    if (typeof value === 'string') kept[key] = boundText(value, MAX_LAST_RESORT_CHARS);
    else if (typeof value === 'number' || typeof value === 'boolean') kept[key] = value;
  }
  kept.truncated = 'only bounded head and classification kept (record exceeded size guard or could not be serialized)';
  return JSON.stringify(kept);
}

/**
 * The record's JSONL line, its newline included, within MAX_RECORD_BYTES of
 * UTF-8. The fallbacks keep the generic writer's existing `truncated` markers.
 */
export function serializeRecord(record: Record<string, unknown>): string {
  const whole = stringify(record);
  if (whole !== undefined && fits(whole)) return whole + '\n';
  let withoutRaw: string | undefined;
  try {
    const { rawRequest: _rq, rawResponse: _rr, ...rest } = record;
    withoutRaw = stringify({
      ...rest,
      truncated: whole === undefined
        ? 'raw bodies dropped (they could not be serialized)'
        : 'raw bodies dropped (record exceeded size guard)',
    });
  } catch {
    withoutRaw = undefined;
  }
  if (withoutRaw !== undefined && fits(withoutRaw)) return withoutRaw + '\n';
  const headAndError = stringify({
    ...pick(record, HEAD_AND_ERROR),
    truncated: withoutRaw === undefined
      ? 'only the head and the error kept (the record could not be serialized)'
      : 'only the head and the error kept (record exceeded size guard)',
  });
  if (headAndError !== undefined && fits(headAndError)) return headAndError + '\n';
  return lastResort(record) + '\n';
}
