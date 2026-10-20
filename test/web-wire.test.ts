/**
 * The page's wire (web/src/wire.ts): what it takes the page's observer
 * sign-in to be, connection by connection. The host acks an observer before
 * its welcome, so a welcome on a socket that got no observer-ack is a full
 * client's, and a refused connection holds no grant. A scripted host stands in
 * for the real one, as the page's own browser runs do.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createWireClient, type WireClient } from '../web/src/wire.js';

type Socket = { send(data: string): void; close(code?: number): void };

// The observer-ack stores the page's session cookie, which a page keeps in
// its document; this stands in for it.
(globalThis as { document?: { cookie: string } }).document ??= { cookie: '' };

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

/** A page's wire to a host that acks each connection as an observer granted
 *  `host.ack.scopes` while `host.ack` is set, and welcomes it either way. */
function connect(ack: { scopes: string[] } | null): { host: { ack: { scopes: string[] } | null; sockets: Set<Socket> }; wire: WireClient } {
  const host = { ack, sockets: new Set<Socket>() };
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      open(ws) {
        host.sockets.add(ws);
        if (host.ack) ws.send(JSON.stringify({ type: 'observer-ack', scopes: host.ack.scopes, sessionToken: 'a'.repeat(64), label: 'probe' }));
        ws.send(JSON.stringify({ type: 'welcome' }));
      },
      message() {},
      close(ws) { host.sockets.delete(ws); },
    },
  });
  const wire = createWireClient({ url: `ws://127.0.0.1:${server.port}/ws`, initialDelayMs: 10, maxDelayMs: 20 });
  cleanups.push(() => server.stop(true), () => wire.close());
  return { host, wire };
}

async function until(what: string, ok: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("the page's wire", () => {
  test("a page that signed in as an observer and reconnects as a full client forgets the observer's grant", async () => {
    const { host, wire } = connect({ scopes: ['messages'] });
    await until('the observer sign-in', () => wire.observerState() === 'observer');
    expect(wire.observer()).toEqual({ label: 'probe', scopes: ['messages'] });

    host.ack = null;
    for (const ws of host.sockets) ws.close();
    await until("the full client's welcome", () => wire.observerState() === 'none');
    expect(wire.observer()).toBeNull();
  });

  test('an observer that reconnects and is acked again stays an observer, with the new grant', async () => {
    const { host, wire } = connect({ scopes: ['messages'] });
    await until('the observer sign-in', () => wire.observerState() === 'observer');

    host.ack = { scopes: ['messages', 'tools'] };
    for (const ws of host.sockets) ws.close();
    await until('the second grant', () => (wire.observer()?.scopes.length ?? 0) === 2);
    expect(wire.observerState()).toBe('observer');
  });

  test('a connection the host refuses (4401) leaves the page with no grant', async () => {
    const { host, wire } = connect({ scopes: ['messages', 'thinking', 'tools', 'health', 'ops'] });
    await until('the observer sign-in', () => wire.observerState() === 'observer');

    for (const ws of host.sockets) ws.close(4401);
    await until('the refusal', () => wire.observerState() === 'denied');
    expect(wire.observer()).toBeNull();
  });
});
