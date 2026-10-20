/**
 * One agent's compression debt, as context-manager's getCompressionDebt()
 * reports it, in the words of the Web UI's Health tab, which imports it as
 * `@conhost/web/compression-debt`.
 *
 * Since anima-research/context-manager#272, a report that couldn't read
 * something says so. `failure` names which read failed, `error` says what
 * happened, what it means and what to do, a line each, and each count it
 * couldn't compute is `null`. So the line shows only the counts the report
 * gives, never a 0 it couldn't compute, and the tab shows `error` whole, with
 * its line breaks, beside the host's own next step.
 */
export interface CompressionDebt {
  state?: 'healthy' | 'degraded' | 'critical' | 'unknown';
  /** What happened, what it means and what to do: a line saying what can't
   *  happen, then `Cause:`, `Effect:` and `Fix:` lines. */
  error?: string;
  /** Which read failed, whenever `error` is set: the compression quarantine
   *  ledger, which compression can't run without, or the report itself. */
  failure?: 'quarantine-ledger' | 'report';
  pendingChunks?: number | null;
  oldestPendingAgeMs?: number | null;
  mergeQueueDepth?: number | null;
  mergeQuarantineCount?: number | null;
  compressionQuarantineCount?: number | null;
}

/** How the Health tab tones a debt line: `alarm` for critical, `unread` for a
 *  report that couldn't read something, as it tones a read that failed,
 *  `warn` for degraded, and `quiet` for anything else. */
export type DebtTone = 'alarm' | 'unread' | 'warn' | 'quiet';

export function debtTone(debt: CompressionDebt): DebtTone {
  if (debt.state === 'critical') return 'alarm';
  if (debt.failure !== undefined || debt.state === 'unknown') return 'unread';
  return debt.state === 'degraded' ? 'warn' : 'quiet';
}

/** The line's head, then "N chunk(s) pending · oldest A · merge queue K":
 *  the oldest chunk's age only while some are pending, and the merge queue
 *  only when it holds any. A count the report couldn't compute isn't shown.
 *  The head says what a person most needs: that compression has stopped,
 *  when the ledger it needs can't be read; that the debt can't be checked,
 *  when the report itself failed; and otherwise the state. */
export function debtSummary(debt: CompressionDebt): string {
  const head = debt.failure === 'quarantine-ledger'
    ? `compression has stopped${debt.state === 'critical' ? ' · critical' : ''}`
    : debt.failure === 'report' || debt.state === 'unknown'
      ? "compression debt can't be checked"
      : `compression debt: ${debt.state ?? '?'}`;
  const parts = [head];
  const pending = debt.pendingChunks;
  if (typeof pending === 'number') {
    parts.push(`${pending} chunk(s) pending`);
    if (pending > 0) {
      parts.push(debt.oldestPendingAgeMs != null
        ? `oldest ${debtAge(debt.oldestPendingAgeMs)}`
        : 'age unknown');
    }
  }
  const queue = debt.mergeQueueDepth;
  if (typeof queue === 'number' && queue > 0) parts.push(`merge queue ${queue}`);
  return parts.join(' · ');
}

/** An age as a person reads it: whole minutes under two hours, whole hours from there. */
export function debtAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** The host's own next step, beside the report's message: how to report a
 *  fault in context-manager, for a report that failed, or a store that
 *  can't be read, for the ledger, whose cause may be the store itself. */
export function debtNextStep(debt: CompressionDebt): string | undefined {
  if (debt.failure === 'report') return 'To report it, run /bug with this message as its text.';
  if (debt.failure === 'quarantine-ledger') return 'If the cause names the store itself, run /bug with this message as its text.';
  return undefined;
}
