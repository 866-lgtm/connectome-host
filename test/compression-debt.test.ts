/**
 * One agent's compression debt in the Health tab's words and tone. Since
 * anima-research/context-manager#272, a report that couldn't read something
 * says `unknown` where that decides its state, with `error`, and `null` for
 * each count it couldn't compute. A report from a context-manager before it
 * reads as the tab wrote it.
 */
import { describe, expect, test } from 'bun:test';
import { debtSummary, debtTone, type CompressionDebt } from '../src/web/compression-debt.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A report that failed outright, as the new getCompressionDebt() gives it. */
const failed: CompressionDebt = {
  state: 'unknown',
  error: "the report couldn't be computed: store closed",
  pendingChunks: null,
  oldestPendingAgeMs: null,
  mergeQueueDepth: null,
  mergeQuarantineCount: null,
  compressionQuarantineCount: null,
};

describe('debtSummary', () => {
  test("a report from today's context-manager reads as the tab wrote it", () => {
    expect(debtSummary({ state: 'healthy', pendingChunks: 0, oldestPendingAgeMs: null, mergeQueueDepth: 0 }))
      .toBe('compression debt: healthy · 0 chunk(s) pending');
    expect(debtSummary({ state: 'degraded', pendingChunks: 3, oldestPendingAgeMs: 2 * HOUR + 24_000, mergeQueueDepth: 2 }))
      .toBe('compression debt: degraded · 3 chunk(s) pending · oldest 120m · merge queue 2');
    expect(debtSummary({ state: 'degraded', pendingChunks: 2, oldestPendingAgeMs: 90 * MINUTE + 36_000, mergeQueueDepth: 0 }))
      .toBe('compression debt: degraded · 2 chunk(s) pending · oldest 91m');
    expect(debtSummary({ state: 'degraded', pendingChunks: 1, oldestPendingAgeMs: null, mergeQueueDepth: 0 }))
      .toBe('compression debt: degraded · 1 chunk(s) pending · age unknown');
  });

  test('a count the line shows that the report couldn\'t compute is unknown, never 0', () => {
    expect(debtSummary(failed)).toBe('compression debt: unknown · pending chunks unknown · merge queue unknown');
    expect(debtSummary({ state: 'healthy' })).toBe('compression debt: healthy · pending chunks unknown · merge queue unknown');
    expect(debtSummary({})).toBe('compression debt: ? · pending chunks unknown · merge queue unknown');
  });

  test('a report that read only part keeps the counts it read', () => {
    expect(debtSummary({
      state: 'critical',
      error: "the compression quarantine ledger couldn't be read: EACCES",
      pendingChunks: 5,
      oldestPendingAgeMs: 7 * HOUR,
      mergeQueueDepth: 0,
      mergeQuarantineCount: 0,
      compressionQuarantineCount: null,
    })).toBe('compression debt: critical · 5 chunk(s) pending · oldest 420m');
    expect(debtSummary({
      state: 'unknown',
      error: "the compression quarantine ledger couldn't be read: EACCES",
      pendingChunks: 1,
      oldestPendingAgeMs: 7 * HOUR,
      mergeQueueDepth: 0,
      mergeQuarantineCount: 0,
      compressionQuarantineCount: null,
    })).toBe('compression debt: unknown · 1 chunk(s) pending · oldest 420m');
  });
});

describe('debtTone', () => {
  test('critical is an alarm, unknown is toned as a read that failed, and degraded warns', () => {
    expect(debtTone({ state: 'critical' })).toBe('alarm');
    expect(debtTone(failed)).toBe('unread');
    expect(debtTone({ state: 'degraded' })).toBe('warn');
    expect(debtTone({ state: 'healthy' })).toBe('quiet');
    expect(debtTone({})).toBe('quiet');
  });
});
