/**
 * What each client of the Web UI is sent: an operator, and observers granted
 * health, messages, the conversation's interior, and everything. Each
 * grant's scopes are what the grant tool promises the resident ("'health' =
 * liveness/usage only; ...") and the deployment doc promises the operator
 * ("Each observer sees only its grant's scopes"), so a frame reaches an
 * observer only when its grant covers what the frame carries.
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
  const agent = { name: 'main', model: 'a-model', getContextManager: () => cm };
  // A child's panel answers, as a fleet child's panel ops give them.
  const panels: Record<string, unknown> = {
    'pin-add': { agent: 'main', pins: [], pinsSupported: true, levelHonored: false, candidates: [{ id: 'm1', index: 0, participant: 'user', text: 'a pinned line' }] },
    'settings-update': { agent: 'main', settings: { contextBudgetTokens: 1000, transition: 'stable' }, overrides: [], hotKeys: [], hotConfigurable: true, previewAvailable: false },
    'credential-action': { subscription: false },
  };
  // A fleet whose one autoStart child is still launching, so each bind holds
  // the welcomes for its second.
  const fleet = {
    name: 'fleet',
    getChildren: () => new Map(),
    autoStartLaunching: () => new Set(['kid']),
    autoStartRecorded: () => new Promise<void>(() => {}),
    onChildEvent: () => () => {},
    requestPanel: async (_child: string, op: string) => ({ ok: true, data: panels[op] }),
  };
  const open: Connection[] = [];

  beforeAll(async () => {
    host = await startObservedHost({
      grants: {
        dashboard: ['health'],
        reader: ['messages'],
        interior: ['messages', 'thinking', 'tools'],
        everything: ['health', 'ops', 'messages', 'thinking', 'tools'],
      },
      framework: {
        getAllAgents: () => [agent],
        getAllModules: () => [fleet],
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
      everything: await host.observer('everything'),
    };
    open.push(...Object.values(clients));
    return clients;
  }

  test("a child's events reach an observer only as its scopes cover what each carries, whole, and an operator's command output and kinds no scope names reach full clients alone", async () => {
    const c = await everyone();
    const events = [
      { type: 'message:added', messageId: 'm1', source: 'mcpl:channel-incoming' },
      { type: 'inference:tokens', blockType: 'thinking', content: 'private' },
      { type: 'inference:speech', agentName: 'kid', content: 'thought, then said' },
      { type: 'lifecycle', phase: 'ready', pid: 1, dataDir: '/data/kid' },
      { type: 'snapshot', asOfTs: 1, child: { name: 'kid', pid: 1, startedAt: 1 }, tree: { nodes: [{ secret: true }], callIdIndex: {} } },
      { type: 'command-output', text: 'status of kid', style: null },
      { type: 'a-kind-added-later' },
      { type: 'private:new-kind', detail: 'its own' },
      { type: 'usage:updated', totals: { inputTokens: 1, outputTokens: 1 } },
    ];
    const fleetEvents = host.module as unknown as { handleFleetEvent(name: string, event: unknown): void };
    for (const event of events) fleetEvents.handleFleetEvent('kid', event);
    await host.fence(Object.values(c));
    const kinds = (conn: Connection) => conn.framesOf('child-event').map((f) => (f.event as { type: string }).type);
    expect(kinds(c.operator)).toEqual(events.map((e) => e.type));
    expect(kinds(c.dashboard)).toEqual(['lifecycle', 'usage:updated']);
    expect(kinds(c.reader)).toEqual(['message:added']);
    expect(kinds(c.interior)).toEqual(['message:added', 'inference:tokens', 'inference:speech']);
    expect(kinds(c.everything)).toEqual([
      'message:added', 'inference:tokens', 'inference:speech', 'lifecycle', 'snapshot', 'usage:updated',
    ]);
    // Each goes as the child sent it, named for the child.
    const lifecycle = c.operator.framesOf('child-event').find((f) => (f.event as { type: string }).type === 'lifecycle')!;
    expect(lifecycle).toEqual({ type: 'child-event', childName: 'kid', event: events[3] });
    // The fleet's total that the child's usage updated is usage, which needs health.
    for (const conn of [c.operator, c.dashboard, c.everything]) expect(conn.framesOf('usage').length).toBe(1);
    for (const conn of [c.reader, c.interior]) expect(conn.framesOf('usage')).toEqual([]);
  });

  test("the host's own traces reach an observer only as its scopes cover what each carries", async () => {
    const c = await everyone();
    const traces = [
      { type: 'tool:started', module: 'shell', tool: 'run', callId: 't1', input: { cmd: 'ls' } },
      { type: 'inference:failed', agentName: 'main', error: 'provider said no' },
      { type: 'host:quiesce', drained: true, activeTurns: 0 },
      { type: 'a-trace-added-later' },
      { type: 'usage:updated', totals: { inputTokens: 2, outputTokens: 2 } },
    ];
    for (const trace of traces) host.emitTrace(trace);
    await host.fence(Object.values(c));
    const kinds = (conn: Connection) => conn.framesOf('trace').map((f) => (f.event as { type: string }).type);
    expect(kinds(c.operator)).toEqual(traces.map((t) => t.type));
    expect(kinds(c.dashboard)).toEqual(['host:quiesce', 'usage:updated']);
    expect(kinds(c.reader)).toEqual([]);
    expect(kinds(c.interior)).toEqual(['tool:started']);
    expect(kinds(c.everything)).toEqual(['tool:started', 'inference:failed', 'host:quiesce', 'usage:updated']);
    for (const conn of [c.operator, c.dashboard, c.everything]) expect(conn.framesOf('usage').length).toBe(1);
    for (const conn of [c.reader, c.interior]) expect(conn.framesOf('usage')).toEqual([]);
  });

  test("an incoming message's excerpt reaches only clients that hold messages", async () => {
    const c = await everyone();
    stored = { participant: 'user', content: [{ type: 'text', text: 'hello from zulip' }], metadata: {}, timestamp: new Date() };
    host.emitTrace({ type: 'message:added', messageId: 'm1', source: 'mcpl:channel-incoming' });
    await host.fence(Object.values(c));
    for (const conn of [c.operator, c.reader, c.interior, c.everything]) {
      expect(conn.framesOf('inbound-trigger').map((f) => f.text)).toEqual(['hello from zulip']);
    }
    expect(c.dashboard.framesOf('inbound-trigger')).toEqual([]);
  });

  test('the serving state and the agents\' models reach clients that hold health in the welcome, the serving state live too, and provider calls live', async () => {
    hostStatus = { quiesced: false };
    const c = await everyone();
    const first = (conn: Connection) => conn.framesOf('welcome')[0]!;
    expect(first(c.dashboard).hostMode).toMatchObject({ mode: 'serving' });
    expect(first(c.dashboard).agents).toEqual([{ name: 'main', model: 'a-model' }]);
    expect(first(c.reader).hostMode).toBeUndefined();
    expect(first(c.reader).agents).toEqual([{ name: 'main', model: '' }]);
    hostStatus = { quiesced: true, drained: true };
    (host.module as unknown as { broadcastHostMode(): void }).broadcastHostMode();
    ledgerUpdate!({ calls: [{ model: 'a-model', costUsd: 0.01 }] });
    await host.fence(Object.values(c));
    for (const conn of [c.operator, c.dashboard, c.everything]) {
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
    for (const conn of [c.operator, c.reader, c.interior, c.everything]) {
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

  test("pins and context settings reach full clients alone, a child's as well as the host's, and a child's credential state reaches clients that hold health", async () => {
    const c = await everyone();
    const panelsHere = host.module as unknown as { broadcastPinsList(agent: string): void; broadcastSettingsState(agent: string): void };
    panelsHere.broadcastPinsList('main');
    panelsHere.broadcastSettingsState('main');
    c.operator.ws.send(JSON.stringify({ type: 'pin-add', scope: 'kid', firstMessageId: 'm1' }));
    c.operator.ws.send(JSON.stringify({ type: 'settings-update', scope: 'kid', contextBudgetTokens: 1000 }));
    c.operator.ws.send(JSON.stringify({ type: 'credential-action', scope: 'kid', action: 'recheck' }));
    await c.operator.until('credential-state');
    await c.operator.until('pins-list', (f) => f.scope === 'kid');
    await c.operator.until('settings-state', (f) => f.scope === 'kid');
    await host.fence(Object.values(c));
    expect(c.operator.framesOf('pins-list').map((f) => f.scope)).toEqual(['local', 'kid']);
    expect(c.operator.framesOf('settings-state').map((f) => f.scope)).toEqual(['local', 'kid']);
    for (const conn of [c.dashboard, c.reader, c.interior, c.everything]) {
      expect(conn.framesOf('pins-list')).toEqual([]);
      expect(conn.framesOf('settings-state')).toEqual([]);
    }
    for (const conn of [c.dashboard, c.everything]) expect(conn.framesOf('credential-state').map((f) => f.scope)).toEqual(['kid']);
    for (const conn of [c.reader, c.interior]) expect(conn.framesOf('credential-state')).toEqual([]);
  });

  test('a connection gets no live frame before its welcome', async () => {
    host.rebind();
    // The bind holds every welcome for up to a second, waiting on the child's launch.
    const waiting = await host.operatorOpen();
    open.push(waiting);
    await new Promise((r) => setTimeout(r, 100));
    host.emitTrace({ type: 'message:added', messageId: 'before', source: 'mcpl:channel-incoming' });
    await waiting.until('welcome');
    host.emitTrace({ type: 'message:added', messageId: 'after', source: 'mcpl:channel-incoming' });
    await host.fence([waiting]);
    expect(waiting.frames.findIndex((f) => f.type === 'welcome')).toBe(0);
    expect(waiting.framesOf('trace').map((f) => (f.event as { messageId: string }).messageId)).toEqual(['after']);
  });
});
