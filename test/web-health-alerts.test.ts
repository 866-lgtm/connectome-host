/**
 * WebUI alert strip, /healthz reconciliation (web/src/health-alerts.ts):
 * a row the reconciliation created for an ephemeral subagent clears once
 * that subagent leaves the snapshot (#149), while rows that live traces
 * created, and rows whose agent's read failed, stay.
 */
import { test, expect } from 'bun:test';
import { planHealthAlerts } from '../web/src/health-alerts';
import type { HealthSnapshot } from '../web/src/Health';

type Alerts = Map<string, { message: string }>;

/** Apply a plan the way App.tsx does, tracking which rows it created. */
function apply(h: HealthSnapshot, alerts: Alerts, reconciled: Set<string>): void {
  const plan = planHealthAlerts(h, alerts, reconciled);
  for (const key of plan.remove) {
    alerts.delete(key);
    reconciled.delete(key);
  }
  for (const u of plan.upsert) {
    alerts.set(`${u.agent}:${u.kind}`, { message: u.message });
    reconciled.add(`${u.agent}:${u.kind}`);
  }
}

const SUB = 'spawn-reader-1760000000';

test('a subagent quarantine row clears when the subagent leaves the snapshot', () => {
  const alerts: Alerts = new Map();
  const reconciled = new Set<string>();
  apply({
    agents: [{ name: 'main' }, { name: SUB }],
    compressionQuarantine: { main: { count: 0 }, [SUB]: { count: 1 } },
  }, alerts, reconciled);
  expect(alerts.has(`${SUB}:compression-quarantine`)).toBe(true);

  // Torn down: gone from the agent list and from the quarantine map.
  apply({ agents: [{ name: 'main' }], compressionQuarantine: { main: { count: 0 } } }, alerts, reconciled);
  expect(alerts.has(`${SUB}:compression-quarantine`)).toBe(false);
  expect(reconciled.size).toBe(0);
});

test('a subagent inference-exhausted row clears when the subagent leaves the snapshot', () => {
  const alerts: Alerts = new Map();
  const reconciled = new Set<string>();
  apply({ agents: [{ name: 'main' }, { name: SUB, consecutiveInferenceFailures: 4 }] }, alerts, reconciled);
  expect(alerts.has(`${SUB}:inference-exhausted`)).toBe(true);

  apply({ agents: [{ name: 'main' }] }, alerts, reconciled);
  expect(alerts.has(`${SUB}:inference-exhausted`)).toBe(false);
});

test('a row a live trace created is left to its own lifecycle', () => {
  // The main agent's klaxon raised it; the reconciliation never did.
  const alerts: Alerts = new Map([['gone:compression-quarantine', { message: 'from the klaxon' }]]);
  const reconciled = new Set<string>();
  apply({ agents: [{ name: 'main' }], compressionQuarantine: {} }, alerts, reconciled);
  expect(alerts.has('gone:compression-quarantine')).toBe(true);
});

test('a row stays while its agent\'s quarantine read fails', () => {
  const alerts: Alerts = new Map();
  const reconciled = new Set<string>();
  apply({ agents: [{ name: SUB }], compressionQuarantine: { [SUB]: { count: 2 } } }, alerts, reconciled);
  apply({
    agents: [{ name: SUB }],
    compressionQuarantine: {},
    readFailures: { [SUB]: { compressionQuarantine: 'context manager not initialized' } },
  }, alerts, reconciled);
  expect(alerts.has(`${SUB}:compression-quarantine`)).toBe(true);
});

test('a snapshot without the sections (older host) clears nothing', () => {
  const alerts: Alerts = new Map();
  const reconciled = new Set<string>();
  apply({
    agents: [{ name: SUB, consecutiveInferenceFailures: 3 }],
    compressionQuarantine: { [SUB]: { count: 1 } },
  }, alerts, reconciled);
  expect(alerts.size).toBe(2);
  apply({}, alerts, reconciled);
  expect(alerts.size).toBe(2);
});

test('present agents keep the existing behaviour', () => {
  const alerts: Alerts = new Map();
  const reconciled = new Set<string>();
  const down = { agents: [{ name: 'main', consecutiveInferenceFailures: 3 }], compressionQuarantine: { main: { count: 2 } } };
  apply(down, alerts, reconciled);
  expect([...alerts.keys()].sort()).toEqual(['main:compression-quarantine', 'main:inference-exhausted']);
  // An unchanged condition is not rewritten.
  expect(planHealthAlerts(down, alerts, reconciled).upsert).toEqual([]);
  apply({ agents: [{ name: 'main' }], compressionQuarantine: { main: { count: 0 } } }, alerts, reconciled);
  expect(alerts.size).toBe(0);
});
