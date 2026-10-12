/**
 * Keepalive events must ALL reach stderr.
 *
 * The host unit routes StandardError to service-stderr.log and leaves stdout on
 * the journal, so an event written with console.log lands where no operator
 * greps. That actually happened on fable-cm 2026-08-23: the keepalive refreshed
 * a 523k prefix three times, correctly, while a monitor tailing
 * service-stderr.log reported zero activity for three hours.
 *
 * These tests fail if anyone re-introduces severity routing.
 */
import { describe, test, expect } from 'bun:test';
import {
  logKeepaliveEvent,
  formatKeepaliveEvent,
  KEEPALIVE_LOG_PREFIX,
} from '../src/cache-keepalive-log.js';
import type { KeepaliveEvent } from '@animalabs/membrane';

const EVENTS: KeepaliveEvent[] = [
  { type: 'refreshed', key: 'k1', lane: 'stream', readTokens: 523102, idleMs: 2987020 },
  { type: 'expired', key: 'k1', idleMs: 21600000 },
  { type: 'ineffective', key: 'k1', reason: 'wrote-instead-of-read', readTokens: 0, writeTokens: 523102 },
  { type: 'skipped', key: 'k1', reason: 'no-1h-breakpoint' },
  { type: 'error', key: 'k1', error: '400 invalid_request_error', consecutive: 1 },
  { type: 'disabled', reason: '3 consecutive keepalive failures' },
];

describe('keepalive event logging', () => {
  test('every event type is written, none silently dropped', () => {
    for (const event of EVENTS) {
      const lines: string[] = [];
      logKeepaliveEvent(event, (l) => lines.push(l));
      expect(lines.length).toBe(1);
    }
  });

  test('routine refreshes are logged, not filtered as noise', () => {
    // The regression this guards: treating `refreshed` as too chatty to log
    // leaves no positive evidence the feature ran at all.
    const lines: string[] = [];
    logKeepaliveEvent(EVENTS[0]!, (l) => lines.push(l));
    expect(lines[0]).toContain('refreshed');
    expect(lines[0]).toContain('523102');
  });

  test('lines carry the greppable prefix', () => {
    for (const event of EVENTS) {
      expect(formatKeepaliveEvent(event).startsWith(KEEPALIVE_LOG_PREFIX)).toBe(true);
    }
  });

  test('the payload is machine-readable JSON after the prefix', () => {
    const line = formatKeepaliveEvent(EVENTS[2]!);
    const json = line.slice(KEEPALIVE_LOG_PREFIX.length).trim();
    const parsed = JSON.parse(json) as { type: string; reason: string; writeTokens: number };
    expect(parsed.type).toBe('ineffective');
    expect(parsed.reason).toBe('wrote-instead-of-read');
    expect(parsed.writeTokens).toBe(523102);
  });

  test('DEFAULT SINK IS STDERR for every event type — not stdout', () => {
    // The actual bug. console.error -> stderr -> service-stderr.log;
    // console.log -> stdout -> journal, where nobody looks.
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    const toStdout: string[] = [];
    const toStderr: string[] = [];
    try {
      console.log = (...a: unknown[]) => { toStdout.push(String(a[0])); };
      console.error = (...a: unknown[]) => { toStderr.push(String(a[0])); };
      console.warn = (...a: unknown[]) => { toStderr.push(String(a[0])); };
      for (const event of EVENTS) logKeepaliveEvent(event);
    } finally {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    }
    expect(toStderr.length).toBe(EVENTS.length);
    expect(toStdout.length).toBe(0);
  });
});
