/**
 * One agent's compression debt in the Health tab's words and tone. Since
 * anima-research/context-manager#272, a report that couldn't read something
 * names which read failed (`failure`), says in `error` what happened, what it
 * means and what to do, and gives `null` for each count it couldn't compute.
 * A report from a context-manager before it reads as the tab wrote it, but
 * for an age past two hours, now in hours.
 */
import { describe, expect, test } from 'bun:test';
import { debtAge, debtNextStep, debtSummary, debtTone, type CompressionDebt } from '../src/web/compression-debt.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ledgerError = [
  "Compression can't run.",
  "Cause: the store couldn't read a record compression needs, this agent's compression quarantine ledger (EACCES: permission denied).",
  "Effect: no new conversation is summarized while this lasts. Once the conversation it hasn't summarized no longer fits in its context budget, its turns fail until compression catches up.",
  'Fix: fix what the cause names. Compression resumes by itself once the ledger reads.',
].join('\n');

/** A report that failed outright, as the new getCompressionDebt() gives it. */
const failed: CompressionDebt = {
  state: 'unknown',
  error: 'The compression debt report failed.\nCause: store closed\nEffect: …\nFix: …',
  failure: 'report',
  pendingChunks: null,
  oldestPendingAgeMs: null,
  mergeQueueDepth: null,
  mergeQuarantineCount: null,
  compressionQuarantineCount: null,
};

/** A report that couldn't read only the quarantine ledger. */
const ledger = (over: Partial<CompressionDebt>): CompressionDebt => ({
  state: 'unknown',
  error: ledgerError,
  failure: 'quarantine-ledger',
  pendingChunks: 1,
  oldestPendingAgeMs: 20 * MINUTE,
  mergeQueueDepth: 0,
  mergeQuarantineCount: 0,
  compressionQuarantineCount: null,
  ...over,
});

describe('debtSummary', () => {
  test("a report from today's context-manager reads as the tab wrote it, an age past two hours in hours", () => {
    expect(debtSummary({ state: 'healthy', pendingChunks: 0, oldestPendingAgeMs: null, mergeQueueDepth: 0 }))
      .toBe('compression debt: healthy · 0 chunk(s) pending');
    expect(debtSummary({ state: 'degraded', pendingChunks: 3, oldestPendingAgeMs: 2 * HOUR + 24_000, mergeQueueDepth: 2 }))
      .toBe('compression debt: degraded · 3 chunk(s) pending · oldest 2h · merge queue 2');
    expect(debtSummary({ state: 'degraded', pendingChunks: 2, oldestPendingAgeMs: 90 * MINUTE + 36_000, mergeQueueDepth: 0 }))
      .toBe('compression debt: degraded · 2 chunk(s) pending · oldest 91m');
    expect(debtSummary({ state: 'degraded', pendingChunks: 1, oldestPendingAgeMs: null, mergeQueueDepth: 0 }))
      .toBe('compression debt: degraded · 1 chunk(s) pending · age unknown');
  });

  test('when the ledger compression needs can\'t be read, the head says compression has stopped, with the counts it read', () => {
    expect(debtSummary(ledger({}))).toBe('compression has stopped · 1 chunk(s) pending · oldest 20m');
    expect(debtSummary(ledger({ state: 'degraded', pendingChunks: 4, oldestPendingAgeMs: 3 * HOUR })))
      .toBe('compression has stopped · 4 chunk(s) pending · oldest 3h');
    expect(debtSummary(ledger({ state: 'critical', pendingChunks: 5, oldestPendingAgeMs: 7 * HOUR })))
      .toBe('compression has stopped · critical · 5 chunk(s) pending · oldest 7h');
  });

  test('when the report itself failed, the head says the debt can\'t be checked, and no count it couldn\'t compute is shown', () => {
    expect(debtSummary(failed)).toBe("compression debt can't be checked");
    expect(debtSummary({ state: 'unknown' })).toBe("compression debt can't be checked");
    expect(debtSummary({ state: 'healthy' })).toBe('compression debt: healthy');
    expect(debtSummary({})).toBe('compression debt: ?');
  });
});

describe('debtAge', () => {
  test('whole minutes under two hours, whole hours from there', () => {
    expect(debtAge(119 * MINUTE + 29_000)).toBe('119m');
    expect(debtAge(119 * MINUTE + 31_000)).toBe('2h');
    expect(debtAge(150 * MINUTE)).toBe('3h');
    expect(debtAge(149 * MINUTE)).toBe('2h');
  });
});

describe('debtNextStep', () => {
  test("the host's own next step: /bug for a fault in the report, and for a ledger whose cause is the store", () => {
    expect(debtNextStep(failed)).toBe('To report it, run /bug with this message as its text.');
    expect(debtNextStep(ledger({}))).toBe('If the cause names the store itself, run /bug with this message as its text.');
    expect(debtNextStep({ state: 'unknown' })).toBeUndefined();
    expect(debtNextStep({ state: 'critical', pendingChunks: 5 })).toBeUndefined();
  });
});

describe('debtTone', () => {
  test('critical is an alarm, a report that couldn\'t read something is toned as a read that failed, and degraded warns', () => {
    expect(debtTone({ state: 'critical' })).toBe('alarm');
    expect(debtTone(ledger({ state: 'critical' }))).toBe('alarm');
    expect(debtTone(failed)).toBe('unread');
    expect(debtTone(ledger({ state: 'degraded' }))).toBe('unread');
    expect(debtTone({ state: 'unknown' })).toBe('unread');
    expect(debtTone({ state: 'degraded' })).toBe('warn');
    expect(debtTone({ state: 'healthy' })).toBe('quiet');
    expect(debtTone({})).toBe('quiet');
  });
});
