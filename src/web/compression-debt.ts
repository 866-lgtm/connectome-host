/**
 * One agent's compression debt, as context-manager's getCompressionDebt()
 * reports it, in the words of the Web UI's Health tab, which imports it as
 * `@conhost/web/compression-debt`.
 *
 * Since anima-research/context-manager#272, a report that couldn't read
 * something says so: `state` is `unknown` where what it couldn't read
 * decides the state, `error` says what and why, and each count it couldn't
 * compute is `null`. So a count the line shows that isn't a number reads as
 * unknown, never as 0.
 */
export interface CompressionDebt {
  state?: 'healthy' | 'degraded' | 'critical' | 'unknown';
  /** What the report couldn't read, and why. */
  error?: string;
  pendingChunks?: number | null;
  oldestPendingAgeMs?: number | null;
  mergeQueueDepth?: number | null;
  mergeQuarantineCount?: number | null;
  compressionQuarantineCount?: number | null;
}

/** How the Health tab tones a debt line: `alarm` for critical, `unread` for
 *  unknown, as it tones a read that failed, `warn` for degraded, and `quiet`
 *  for anything else. */
export type DebtTone = 'alarm' | 'unread' | 'warn' | 'quiet';

export function debtTone(debt: CompressionDebt): DebtTone {
  switch (debt.state) {
    case 'critical': return 'alarm';
    case 'unknown': return 'unread';
    case 'degraded': return 'warn';
    default: return 'quiet';
  }
}

/** "compression debt: <state> · N chunk(s) pending · oldest Mm · merge queue K":
 *  the oldest chunk's age only while some are pending, and the merge queue
 *  only when it holds any or its depth isn't a number. */
export function debtSummary(debt: CompressionDebt): string {
  const parts = [`compression debt: ${debt.state ?? '?'}`];
  const pending = debt.pendingChunks;
  if (typeof pending !== 'number') {
    parts.push('pending chunks unknown');
  } else {
    parts.push(`${pending} chunk(s) pending`);
    if (pending > 0) {
      parts.push(debt.oldestPendingAgeMs != null
        ? `oldest ${Math.round(debt.oldestPendingAgeMs / 60000)}m`
        : 'age unknown');
    }
  }
  const queue = debt.mergeQueueDepth;
  if (typeof queue !== 'number') parts.push('merge queue unknown');
  else if (queue > 0) parts.push(`merge queue ${queue}`);
  return parts.join(' · ');
}
