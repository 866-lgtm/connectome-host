/**
 * What each client of the Web UI is sent: an operator, and observers granted
 * health, messages, or the whole interior. Each grant's scopes are what the
 * grant tool promises the resident ("'health' = liveness/usage only; ...") and
 * the deployment doc promises the operator ("Each observer sees only its
 * grant's scopes"), so a frame reaches an observer only when its grant covers
 * what the welcome and its requests would give it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startObservedHost, type Connection, type ObservedHost } from './web-ui-observed-host.js';

describe('what each client is sent', () => {
  let host: ObservedHost;
  let branch = { id: 'b1', name: 'main' };
  let stored: Record<string, unknown> | null = null;
  let hostStatus: Record<string, unknown> = { quiesced: false };
  let ledgerUpdate: ((ledger: unknown) => void) | undefined;
  const cm = {
    getAllMessages: () => [],
    currentBranch: () => branch,
    getMessage: () => stored,
  };
  const agent = { name: 'main', model: 'm', getContextManager: () => cm };
  const open: Connection[] = [];

  beforeAll(async () => {
    host = await startObservedHost({
      grants: { dashboard: ['health'], reader: ['messages'], interior: ['messages', 'thinking', 'tools'] },
      framework: {
        getAllAgents: () => [agent],
        getAgent: (name: string) => (name === 'main' ? agent : undefined),
        getHostModeStatus: () => hostStatus,
        getAgentRuntimeSettings: () => ({ contextBudgetTokens: 1000, transition: 'stable' }),
      },
      sessionManager: { getActiveSession: () => ({ id: 's1', name: 'Debugging the bridge', manuallyNamed: false }) },
      config: {
        callLedger: {
          snapshot: () => undefined,
          onUpdate: (update: (ledger: unknown) => void) => {
            ledgerUpdate = update;
            return () => {};
          },
        },
      },
    });
  });

  afterAll(async () => {
    for (const c of open) c.ws.close();
    await host.stop();
  });

  async function everyone() {
    const clients = {
      operator: await host.operator(),
      dashboard: await host.observer('dashboard'),
      reader: await host.observer('reader'),
      interior: await host.observer('interior'),
    };
    open.push(...Object.values(clients));
    return clients;
  }

  test("a child's events reach an observer only as its scopes allow, and an operator's command output and kinds no scope names reach full clients alone", async () => {
    const c = await everyone();
    const events = [
      { type: 'message:added', messageId: 'm1', source: 'mcpl:channel-incoming' },
      { type: 'inference:tokens', blockType: 'thinking', content: 'private' },
      { type: 'lifecycle', phase: 'ready', pid: 1, dataDir: '/data/kid' },
      { type: 'snapshot', asOfTs: 1, child: { name: 'kid', pid: 1, startedAt: 1 }, tree: { nodes: [{ secret: true }], callIdIndex: {} } },
      { type: 'command-output', text: 'status of kid', style: null },
      { type: 'a-kind-added-later' },
      { type: 'usage:updated', totals: { inputTokens: 1, outputTokens: 1 } },
    ];
    const fleet = host.module as unknown as { handleFleetEvent(name: string, event: unknown): void };
    for (const event of events) fleet.handleFleetEvent('kid', event);
    await host.fence(Object.values(c));
    const kinds = (conn: Connection) => conn.framesOf('child-event').map((f) => (f.event as { type: string }).type);
    expect(kinds(c.operator)).toEqual(events.map((e) => e.type));
    expect(kinds(c.dashboard)).toEqual(['lifecycle', 'usage:updated']);
    expect(kinds(c.reader)).toEqual(['message:added']);
    expect(kinds(c.interior)).toEqual(['message:added', 'inference:tokens', 'snapshot']);
    // The fleet's total that the child's usage updated is usage, which needs health.
    for (const conn of [c.operator, c.dashboard]) expect(conn.framesOf('usage').length).toBe(1);
    for (const conn of [c.reader, c.interior]) expect(conn.framesOf('usage')).toEqual([]);
  });

  test("an incoming message's excerpt reaches only clients that hold messages", async () => {
    const c = await everyone();
    stored = { participant: 'user', content: [{ type: 'text', text: 'hello from zulip' }], metadata: {}, timestamp: new Date() };
    host.emitTrace({ type: 'message:added', messageId: 'm1', source: 'mcpl:channel-incoming' });
    await host.fence(Object.values(c));
    for (const conn of [c.operator, c.reader, c.interior]) {
      expect(conn.framesOf('inbound-trigger').map((f) => f.text)).toEqual(['hello from zulip']);
    }
    expect(c.dashboard.framesOf('inbound-trigger')).toEqual([]);
  });

  test('host serving state and provider calls reach clients that hold health, in the welcome and live', async () => {
    hostStatus = { quiesced: false };
    const c = await everyone();
    expect(c.dashboard.framesOf('welcome')[0]!.hostMode).toMatchObject({ mode: 'serving' });
    expect(c.reader.framesOf('welcome')[0]!.hostMode).toBeUndefined();
    hostStatus = { quiesced: true, drained: true };
    (host.module as unknown as { broadcastHostMode(): void }).broadcastHostMode();
    ledgerUpdate!({ calls: [{ model: 'a-model', costUsd: 0.01 }] });
    await host.fence(Object.values(c));
    for (const conn of [c.operator, c.dashboard]) {
      expect(conn.framesOf('host-mode').map((f) => (f.hostMode as { mode: string }).mode)).toEqual(['quiesced']);
      expect(conn.framesOf('call-ledger').length).toBe(1);
    }
    for (const conn of [c.reader, c.interior]) {
      expect(conn.framesOf('host-mode')).toEqual([]);
      expect(conn.framesOf('call-ledger')).toEqual([]);
    }
  });

  test("after a branch switch, branch-changed reaches clients that hold messages, and a health observer's refreshed welcome has the new branch's id and no names", async () => {
    branch = { id: 'b1', name: 'main' };
    const c = await everyone();
    branch = { id: 'b2', name: 'experiment' };
    // What a switch does after it lands: tell clients, then welcome them again.
    (host.module as unknown as { broadcastBranchChanged(): void }).broadcastBranchChanged();
    await host.fence(Object.values(c));
    for (const conn of [c.operator, c.reader, c.interior]) {
      expect(conn.framesOf('branch-changed').map((f) => f.branch)).toEqual([{ id: 'b2', name: 'experiment' }]);
    }
    expect(c.dashboard.framesOf('branch-changed')).toEqual([]);
    const refreshed = c.dashboard.framesOf('welcome').at(-1)!;
    expect(refreshed.branch).toEqual({ id: 'b2', name: '' });
    expect(refreshed.session).toEqual({ id: 's1', name: '', autoNamed: true });
    const read = c.reader.framesOf('welcome').at(-1)!;
    expect(read.branch).toEqual({ id: 'b2', name: 'experiment' });
    expect(read.session).toEqual({ id: 's1', name: 'Debugging the bridge', autoNamed: true });
  });

  test('pins and context settings reach full clients alone', async () => {
    const c = await everyone();
    const panels = host.module as unknown as { broadcastPinsList(agent: string): void; broadcastSettingsState(agent: string): void };
    panels.broadcastPinsList('main');
    panels.broadcastSettingsState('main');
    await host.fence(Object.values(c));
    expect(c.operator.framesOf('pins-list').length).toBe(1);
    expect(c.operator.framesOf('settings-state').length).toBe(1);
    for (const conn of [c.dashboard, c.reader, c.interior]) {
      expect(conn.framesOf('pins-list')).toEqual([]);
      expect(conn.framesOf('settings-state')).toEqual([]);
    }
  });
});
