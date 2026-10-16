/**
 * /healthz reconciliation of the alert strip's durable-state rows
 * (compression quarantine, inference hard-down), worked out as a plan the
 * page applies. Kept free of Solid and the DOM so it can be tested alone.
 *
 * `reconciled` holds the keys of rows this reconciliation created itself.
 * A row for an agent that has left the snapshot (an ephemeral subagent torn
 * down) is removed only when its key is in that set: such a row has nothing
 * else that would ever clear it. Rows that live traces created keep their
 * own lifecycle (a `-clear` trace, or a snapshot that reports the agent).
 */

import type { HealthSnapshot } from './Health';

export interface HealthAlertUpsert {
  kind: string;
  agent: string;
  message: string;
}

export interface HealthAlertPlan {
  upsert: HealthAlertUpsert[];
  remove: string[];
}

const QUARANTINE = 'compression-quarantine';
const EXHAUSTED = 'inference-exhausted';

/** The agent part of a `${agent}:${kind}` key, or undefined for another kind. */
function agentOf(key: string, kind: string): string | undefined {
  const suffix = `:${kind}`;
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : undefined;
}

export function planHealthAlerts(
  h: HealthSnapshot,
  current: ReadonlyMap<string, { message: string }>,
  reconciled: ReadonlySet<string>,
): HealthAlertPlan {
  const plan: HealthAlertPlan = { upsert: [], remove: [] };
  const quarantine = h.compressionQuarantine;
  for (const [agent, q] of Object.entries(quarantine ?? {})) {
    const key = `${agent}:${QUARANTINE}`;
    if ((q.count ?? 0) > 0) {
      if (!current.has(key)) {
        plan.upsert.push({
          kind: QUARANTINE,
          agent,
          message: `${q.count} chunk(s) in compression quarantine — spans stay raw and will eventually exhaust the context budget.`,
        });
      }
    } else {
      plan.remove.push(key);
    }
  }
  // An agent missing from the map is gone, or has nothing to report, unless
  // its quarantine read failed: then the row stays until a read succeeds.
  // A snapshot without the map at all (an older host) says nothing.
  if (quarantine) {
    for (const key of reconciled) {
      const agent = agentOf(key, QUARANTINE);
      if (agent === undefined || Object.hasOwn(quarantine, agent)) continue;
      if (h.readFailures?.[agent]?.compressionQuarantine !== undefined) continue;
      plan.remove.push(key);
    }
  }

  const agents = h.agents;
  for (const a of agents ?? []) {
    const key = `${a.name}:${EXHAUSTED}`;
    const streak = a.consecutiveInferenceFailures ?? 0;
    if (streak >= 3) {
      const message = `${streak} consecutive inference failures — agent is down.`
        + (a.lastInference?.lastError ? ` Last: ${a.lastInference.lastError}` : '');
      // Only touch the entry when the condition actually changed —
      // rewriting `at` every poll would show a perpetual "5s ago" and
      // re-sort the strip on every cycle.
      if (current.get(key)?.message !== message) {
        plan.upsert.push({ kind: EXHAUSTED, agent: a.name, message });
      }
    } else {
      plan.remove.push(key);
    }
  }
  if (Array.isArray(agents)) {
    const present = new Set(agents.map((a) => a.name));
    for (const key of reconciled) {
      const agent = agentOf(key, EXHAUSTED);
      if (agent !== undefined && !present.has(agent)) plan.remove.push(key);
    }
  }
  return plan;
}
