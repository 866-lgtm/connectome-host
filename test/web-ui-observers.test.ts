/**
 * Observer identity (docs/observability.md M2) — unit tests for the pure
 * layer (verifyHello, scope filters, sessions, file ops) plus an end-to-end
 * WS drill against a real WebUiModule:
 *
 *   no grants → everything behaves as pre-observer builds (401s)
 *   grant hot-appears → static goes public, unauthenticated WS upgrade OK
 *   signed hello → observer-ack with the grant's scopes + session token
 *   session cookie → /healthz by scope, /debug still denied without 'debug'
 *   wrong key / stale timestamp / wrong host → rejected
 *   observer is read-only (user-message → forbidden)
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerClientsForTests,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';
import {
  ObserverRegistry,
  ObserverSessions,
  closeConnectionsWithoutGrant,
  observerStatement,
  saveObserversFile,
  loadObserversFile,
  filterEntryForScopes,
  traceRequiredScope,
  scopeWelcome,
  type ObserverScope,
  type ObserversFile,
} from '../src/modules/web-ui-observers.js';
import type { WelcomeMessage, WelcomeMessageEntry } from '../src/web/protocol.js';

// ---------------------------------------------------------------------------
// Key helpers — raw ed25519 via node:crypto
// ---------------------------------------------------------------------------

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  const id = `ed25519:${raw.toString('base64url')}`;
  return { id, privateKey };
}

function helloFor(kp: ReturnType<typeof makeKeypair>, host: string, timestamp = new Date().toISOString()) {
  const proof = cryptoSign(null, Buffer.from(observerStatement(host, timestamp), 'utf8'), kp.privateKey);
  return {
    scheme: 'ed25519' as const,
    id: kp.id,
    proof: proof.toString('base64url'),
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Unit: registry verification
// ---------------------------------------------------------------------------

describe('ObserverRegistry.verifyHello', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'observers-unit-'));
  const path = join(tmp, 'observers.json');
  const kp = makeKeypair();
  const HOST = 'agent.example:7342';

  const file: ObserversFile = {
    observers: [
      { key: kp.id, label: 'test-device', scopes: ['health', 'ops'] },
      { key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', label: 'expired', scopes: ['health'], expires: '2000-01-01T00:00:00Z' },
    ],
  };
  saveObserversFile(path, file);
  const registry = new ObserverRegistry(path);
  registry.start();
  afterAll(() => { registry.stop(); rmSync(tmp, { recursive: true, force: true }); });

  test('valid hello → grant + scopes', () => {
    const res = registry.verifyHello(helloFor(kp, HOST), HOST);
    expect(res).not.toBeNull();
    expect(res!.grant.label).toBe('test-device');
    expect([...res!.scopes].sort()).toEqual(['health', 'ops']);
  });

  test('stale timestamp rejected', () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(registry.verifyHello(helloFor(kp, HOST, old), HOST)).toBeNull();
  });

  test('host mismatch rejected (relay-proof)', () => {
    expect(registry.verifyHello(helloFor(kp, 'evil.example:7342'), HOST)).toBeNull();
  });

  test('unknown key rejected', () => {
    const stranger = makeKeypair();
    expect(registry.verifyHello(helloFor(stranger, HOST), HOST)).toBeNull();
  });

  test('tampered proof rejected', () => {
    const h = helloFor(kp, HOST);
    const buf = Buffer.from(h.proof, 'base64url');
    buf[0]! ^= 0xff;
    expect(registry.verifyHello({ ...h, proof: buf.toString('base64url') }, HOST)).toBeNull();
  });

  test('parse-error keeps previous grants (fail-safe)', () => {
    expect(loadObserversFile(path)).not.toBeNull();
    writeFileSync(path, '{not json');
    expect(loadObserversFile(path)).toBeNull();
    // registry still holds the last good state
    expect(registry.verifyHello(helloFor(kp, HOST), HOST)).not.toBeNull();
    saveObserversFile(path, file); // restore
  });
});

describe('ObserverRegistry when the grants file is removed', () => {
  test('the next check admits no one the file had admitted, says so once, and reads a file put back', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-removed-'));
    const path = join(tmp, 'observers.json');
    const kp = makeKeypair();
    const HOST = 'agent.example:7342';
    const grants: ObserversFile = { observers: [{ key: kp.id, label: 'device', scopes: ['health'], protected: true }] };
    saveObserversFile(path, grants);
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const registry = new ObserverRegistry(path, 20);
    const until = async (done: () => boolean) => {
      const end = Date.now() + 3_000;
      while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    };
    const admits = () => registry.verifyHello(helloFor(kp, HOST), HOST) !== null;
    const gone = `[webui-observers] ${path} is gone — admitting no grants from it`;
    try {
      registry.start();
      expect(admits()).toBe(true);
      rmSync(path);
      await until(() => !registry.active());
      for (let i = 0; i < 5; i++) check(registry); // five more checks find it gone
      expect(admits()).toBe(false);
      expect(registry.active()).toBe(false);
      expect(lines.filter((l) => l.includes('admitting no grants'))).toEqual([gone]);
      saveObserversFile(path, grants);
      await until(() => registry.active());
      expect(admits()).toBe(true);
      // Removed again after a good read, it's said again.
      rmSync(path);
      await until(() => !registry.active());
      expect(lines.filter((l) => l.includes('admitting no grants'))).toEqual([gone, gone]);
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('grants kept while the file wasn\'t valid JSON go too when it\'s removed', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-removed-'));
    const path = join(tmp, 'observers.json');
    const kp = makeKeypair();
    saveObserversFile(path, { observers: [{ key: kp.id, label: 'device', scopes: ['health'] }] });
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const registry = new ObserverRegistry(path, 20);
    const until = async (done: () => boolean) => {
      const end = Date.now() + 3_000;
      while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    };
    try {
      registry.start();
      writeFileSync(path, '{"observers": [');
      const later = new Date(Date.now() + 5_000);
      utimesSync(path, later, later);
      await until(() => lines.some((l) => l.endsWith('keeping the previous grants until it parses')));
      expect(lines.some((l) => l.endsWith('keeping the previous grants until it parses'))).toBe(true);
      expect(registry.active()).toBe(true);
      rmSync(path);
      await until(() => !registry.active());
      expect(registry.active()).toBe(false);
      expect(lines).toContain(`[webui-observers] ${path} is gone — admitting no grants from it`);
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('ObserverRegistry checks', () => {
  const setup = () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-checks-'));
    const path = join(tmp, 'observers.json');
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const registry = new ObserverRegistry(path, 60_000); // checks driven by hand
    const done = () => { registry.stop(); spy.mockRestore(); rmSync(tmp, { recursive: true, force: true }); };
    return { tmp, path, lines, registry, done };
  };

  test('a host that never had the file says nothing about it', () => {
    const { lines, registry, done } = setup();
    try {
      registry.start();
      for (let i = 0; i < 5; i++) check(registry);
      expect(lines).toEqual([]);
      expect(registry.active()).toBe(false);
    } finally { done(); }
  });

  test('a file back by the second check, as after a save that removes it first, changes nothing', () => {
    const { path, lines, registry, done } = setup();
    const kp = makeKeypair();
    try {
      saveObserversFile(path, { observers: [{ key: kp.id, label: 'device', scopes: ['health'] }] });
      registry.start();
      rmSync(path);
      check(registry); // the first check to miss it takes nothing away
      expect(registry.grants().map((g) => g.label)).toEqual(['device']);
      saveObserversFile(path, { observers: [{ key: kp.id, label: 'device', scopes: ['health'] }] });
      check(registry);
      check(registry);
      expect(registry.grants().map((g) => g.label)).toEqual(['device']);
      expect(lines.filter((l) => l.includes('admitting no grants'))).toEqual([]);
    } finally { done(); }
  });

  test('removing a file the viewer couldn\'t use is said too', () => {
    const { path, lines, registry, done } = setup();
    try {
      writeFileSync(path, '{"observers": [');
      registry.start();
      rmSync(path);
      check(registry);
      check(registry);
      expect(lines.at(-1)).toBe(`[webui-observers] ${path} is gone — admitting no grants from it`);
    } finally { done(); }
  });

  test('a file put back with its old mtime, or replaced by one with the same mtime, is read again', () => {
    const { path, registry, done } = setup();
    const a = makeKeypair();
    const b = makeKeypair();
    try {
      saveObserversFile(path, { observers: [{ key: a.id, label: 'a', scopes: ['health'] }] });
      const was = statSync(path).mtime;
      registry.start();
      rmSync(path);
      check(registry);
      check(registry);
      expect(registry.active()).toBe(false);
      saveObserversFile(path, { observers: [{ key: a.id, label: 'a', scopes: ['health'] }] });
      utimesSync(path, was, was);
      check(registry);
      expect(registry.grants().map((g) => g.label)).toEqual(['a']);
      // Between two checks, a file with other grants and the same mtime.
      saveObserversFile(path, { observers: [{ key: b.id, label: 'b', scopes: ['health'] }] });
      utimesSync(path, was, was);
      check(registry);
      expect(registry.grants().map((g) => g.label)).toEqual(['b']);
    } finally { done(); }
  });

  test('a file that can\'t be reached from the start is named once', () => {
    const { tmp, lines, done } = setup();
    // A name longer than a directory entry can be fails the stat with
    // ENAMETOOLONG, which a test can make without chmod, as root too.
    const path = join(tmp, 'x'.repeat(300), 'observers.json');
    const registry = new ObserverRegistry(path, 60_000);
    try {
      registry.start();
      for (let i = 0; i < 5; i++) check(registry);
      expect(lines).toEqual([`[webui-observers] ${path} can't be read (ENAMETOOLONG) — admitting no grants from it`]);
      expect(registry.active()).toBe(false);
    } finally { registry.stop(); done(); }
  });

  test('a link whose file goes away is named as a link', () => {
    const { tmp, path, lines, registry, done } = setup();
    const kp = makeKeypair();
    const target = join(tmp, 'grants.json');
    try {
      saveObserversFile(target, { observers: [{ key: kp.id, label: 'a', scopes: ['health'] }] });
      symlinkSync(target, path);
      registry.start();
      expect(registry.grants().map((g) => g.label)).toEqual(['a']);
      rmSync(target);
      check(registry);
      check(registry);
      expect(registry.grants()).toEqual([]);
      expect(lines.at(-1)).toBe(`[webui-observers] ${path} is a link to a file that can't be read (ENOENT) — admitting no grants from it`);
    } finally { done(); }
  });

  test('a file there but unreadable is named with why', () => {
    const { path, lines, registry, done } = setup();
    try {
      saveObserversFile(path, { observers: [] });
      registry.start();
      rmSync(path);
      symlinkSync(path, path); // a link to itself: ELOOP
      check(registry);
      check(registry);
      expect(lines.at(-1)).toBe(`[webui-observers] ${path} can't be read (ELOOP) — admitting no grants from it`);
    } finally { done(); }
  });
});

/** Run one of the registry's checks now, as its timer would. */
function check(registry: ObserverRegistry): void {
  (registry as unknown as { check(): void }).check();
}

/** Wait until `done` holds, up to `ms`. */
async function waitUntil(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe('observer sessions and connections end with their grant', () => {
  const K = `ed25519:${'K'.repeat(42)}A`; // canonical: its last character carries no stray bits

  test('a session keeps only what its grant still holds, and ends when the grant is revoked, expires or its file goes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-sessions-'));
    const path = join(tmp, 'observers.json');
    const write = (observers: ObserversFile['observers']) => { saveObserversFile(path, { observers }); check(registry); };
    saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health', 'ops'] }] });
    const registry = new ObserverRegistry(path, 60_000); // checks driven by hand
    const sessions = new ObserverSessions();
    let now = Date.now();
    const live = (key: string) => registry.liveScopes(key, now);
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.start();
      const token = sessions.mint(new Set(['health', 'ops'] as ObserverScope[]), { key: K });
      expect([...sessions.lookup(token, live)!.scopes].sort()).toEqual(['health', 'ops']);

      write([{ key: K, label: 'phone', scopes: ['health'] }]);
      expect([...sessions.lookup(token, live)!.scopes]).toEqual(['health']);
      // Widened again: the narrowing stays, and the next hello takes up the wider grant.
      write([{ key: K, label: 'phone', scopes: ['health', 'ops'] }]);
      expect([...sessions.lookup(token, live)!.scopes]).toEqual(['health']);

      write([]);
      expect(sessions.lookup(token, live)).toBeNull();

      // A grant that keeps none of the session's scopes ends it, at a lookup
      // and at a check alike.
      write([{ key: K, label: 'phone', scopes: ['ops'] }]);
      const opsLess = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      const unused = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      expect(sessions.lookup(opsLess, live)).toBeNull();
      expect(sessions.narrowToGrants(live)).toBe(1);
      expect(sessions.lookup(unused, live)).toBeNull();

      write([{ key: K, label: 'phone', scopes: ['health'], expires: new Date(now + 60_000).toISOString() }]);
      const expiring = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      expect(sessions.lookup(expiring, live)).not.toBeNull();
      now += 120_000;
      expect(sessions.lookup(expiring, live)).toBeNull();
      // The lookup ended it, so the next check has nothing left to count.
      expect(sessions.narrowToGrants(live)).toBe(0);
      now = Date.now();

      write([{ key: K, label: 'phone', scopes: ['health'] }]);
      const removed = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      expect(sessions.lookup(removed, live)).not.toBeNull();
      rmSync(path);
      check(registry);
      check(registry); // a removal counts at the second check that misses the file
      expect(sessions.lookup(removed, live)).toBeNull();

      // A password session has no grant to end with.
      expect(sessions.lookup(sessions.mint(new Set(), { full: true }), live)?.full).toBe(true);
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a session ends at the check that finds its grant gone, used or not, and granting the key again doesn\'t bring it back', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-session-drop-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health'] }] });
    const registry = new ObserverRegistry(path, 60_000);
    const sessions = new ObserverSessions();
    const live = (key: string) => registry.liveScopes(key);
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.start();
      const used = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      const unused = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      const password = sessions.mint(new Set(), { full: true });
      expect(sessions.lookup(used, live)).not.toBeNull();
      expect(sessions.narrowToGrants(live)).toBe(0);

      saveObserversFile(path, { observers: [] });
      check(registry);
      expect(sessions.narrowToGrants(live)).toBe(2); // the check ends both, whether used or not

      saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health'] }] });
      check(registry);
      expect(sessions.lookup(used, live)).toBeNull();
      expect(sessions.lookup(unused, live)).toBeNull();
      expect(sessions.lookup(password, live)?.full).toBe(true);
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('at each check, an unused session narrows with its grant and ends when the grant expires', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-session-check-'));
    const path = join(tmp, 'observers.json');
    const at = Date.now();
    saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health', 'ops'], expires: new Date(at + 60_000).toISOString() }] });
    const registry = new ObserverRegistry(path, 60_000);
    const sessions = new ObserverSessions();
    let now = at;
    const live = (key: string) => registry.liveScopes(key, now);
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.start();
      const token = sessions.mint(new Set(['health', 'ops'] as ObserverScope[]), { key: K });
      // Narrowed and widened again between lookups: the check stored the narrowing.
      saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health'], expires: new Date(at + 60_000).toISOString() }] });
      check(registry);
      expect(sessions.narrowToGrants(live)).toBe(0);
      saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health', 'ops'], expires: new Date(at + 60_000).toISOString() }] });
      check(registry);
      expect(sessions.narrowToGrants(live)).toBe(0);
      expect([...sessions.lookup(token, live)!.scopes]).toEqual(['health']);
      // The grant expires: the check ends the session, unused.
      now = at + 120_000;
      expect(sessions.narrowToGrants(live)).toBe(1);
      now = at;
      expect(sessions.lookup(token, live)).toBeNull();
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an entry the viewer can\'t use counts as no grant: its session ends at the check', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-session-unusable-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health'] }] });
    const registry = new ObserverRegistry(path, 60_000);
    const sessions = new ObserverSessions();
    const live = (key: string) => registry.liveScopes(key);
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.start();
      const token = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      // An unknown scope makes the entry one the viewer can't use.
      saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health', 'everything' as ObserverScope] }] });
      check(registry);
      expect(registry.liveScopes(K)).toBeNull();
      expect(sessions.narrowToGrants(live)).toBe(1);
      expect(sessions.lookup(token, live)).toBeNull();
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a session already past its 12 hours isn't counted among those a check ended", () => {
    const sessions = new ObserverSessions();
    const token = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
    // Its 12 hours are up, and no mint has swept it since.
    const held = (sessions as unknown as { sessions: Map<string, { expiresAt: number }> }).sessions;
    held.get(token)!.expiresAt = Date.now() - 1;
    expect(sessions.narrowToGrants(() => null)).toBe(0);
    expect(sessions.lookup(token, () => new Set(['health'] as ObserverScope[]))).toBeNull();
    // It's left for the next mint to sweep.
    expect(held.has(token)).toBe(true);
    sessions.mint(new Set(), { full: true });
    expect(held.has(token)).toBe(false);
  });

  test('a read that fails after a good stat takes the grants away only at the second check in a row', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-read-fails-'));
    const path = join(tmp, 'observers.json');
    const grants: ObserversFile = { observers: [{ key: K, label: 'phone', scopes: ['health'] }] };
    saveObserversFile(path, grants);
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const registry = new ObserverRegistry(path, 60_000);
    // A directory in its place: the stat succeeds and the read fails (EISDIR).
    const unreadable = () => { rmSync(path, { recursive: true, force: true }); mkdirSync(path); };
    const readable = () => { rmSync(path, { recursive: true, force: true }); saveObserversFile(path, grants); };
    try {
      registry.start();
      unreadable();
      check(registry);
      expect(registry.liveScopes(K)).not.toBeNull(); // one failed read changes nothing
      readable();
      check(registry);
      expect(registry.liveScopes(K)).not.toBeNull();
      expect(lines.filter((l) => l.includes('admitting no grants'))).toEqual([]);

      unreadable();
      check(registry);
      expect(registry.liveScopes(K)).not.toBeNull();
      check(registry);
      expect(registry.liveScopes(K)).toBeNull();
      expect(lines.filter((l) => l.includes('admitting no grants')).length).toBe(1);
      expect(lines.at(-1)).toStartWith(`[webui-observers] ${path} can't be read (EISDIR`);
      readable();
      check(registry);
      expect(registry.liveScopes(K)).not.toBeNull();
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the sweep closes a connection whose grant is gone (4401) or narrowed (4403), and leaves the rest', () => {
    const closed: string[] = [];
    const conn = (name: string, auth: string, observerKey: string | undefined, scopes: ObserverScope[] | null, throws = false) => ({
      auth,
      observerKey,
      label: observerKey === undefined ? undefined : name,
      scopes: scopes === null ? null : new Set(scopes),
      ws: { close: (code?: number, reason?: string) => { if (throws) throw new Error('socket'); closed.push(`${name}:${code}:${reason}`); } },
    });
    const grants: Record<string, Set<ObserverScope>> = { A: new Set(['health', 'ops']), B: new Set(['health']), W: new Set(['health', 'ops']) };
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      const throws = conn('throws', 'observer', 'C', ['health'], true);
      const connections = [
        conn('same', 'observer', 'A', ['health', 'ops']),
        conn('widened', 'observer', 'W', ['health']),
        conn('narrowed', 'observer', 'B', ['health', 'ops']),
        throws,
        conn('gone', 'observer', 'C', ['health']),
        conn('keyless', 'observer', undefined, ['health']),
        conn('password', 'full', undefined, null),
        conn('pending', 'pending', undefined, null),
      ];
      const registry = { liveScopes: (key: string) => grants[key] ?? null };
      const swept = closeConnectionsWithoutGrant(connections, registry);
      expect(closed).toEqual([
        'narrowed:4403:observer grant narrowed',
        'gone:4401:observer grant gone or expired',
        'keyless:4401:observer grant gone or expired',
      ]);
      // The socket whose close threw isn't counted: it's handed back for the
      // caller to drop, and named.
      expect(swept.closed).toBe(3);
      expect(swept.unclosed).toEqual([throws]);
      expect(lines).toEqual(["[webui-observers] observer connection couldn't be closed: throws (socket); it gets nothing more"]);
    } finally { spy.mockRestore(); }
  });

  test('the sweep closes a connection whose grant has expired', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-expired-'));
    const path = join(tmp, 'observers.json');
    const at = Date.now();
    saveObserversFile(path, { observers: [
      { key: K, label: 'expired', scopes: ['health'], expires: new Date(at - 1000).toISOString() },
    ] });
    const registry = new ObserverRegistry(path, 60_000);
    const closed: number[] = [];
    try {
      registry.start();
      expect(registry.grants().map((g) => g.label)).toEqual(['expired']);
      const swept = closeConnectionsWithoutGrant(
        [{ auth: 'observer', observerKey: K, scopes: new Set(['health'] as ObserverScope[]), ws: { close: (code?: number) => { closed.push(code!); } } }],
        registry,
      );
      expect(swept).toEqual({ closed: 1, unclosed: [] });
      expect(closed).toEqual([4401]);
    } finally {
      registry.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a grants file that parses but has the wrong shape takes every grant away at the check that reads it, and the sweep closes their connections', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-shape-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [{ key: K, label: 'kept', scopes: ['health'] }] });
    const registry = new ObserverRegistry(path, 50);
    const closed: number[] = [];
    const connection = {
      auth: 'observer', observerKey: K, scopes: new Set(['health'] as ObserverScope[]),
      ws: { close: (code?: number) => { closed.push(code!); connection.auth = 'closed'; } },
    };
    let checksSinceWrite = -1;
    let closedAt = -1;
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.start(() => {
        if (checksSinceWrite >= 0) checksSinceWrite++;
        if (closeConnectionsWithoutGrant([connection], registry).closed > 0) closedAt = checksSinceWrite;
      });
      expect(registry.liveScopes(K)).not.toBeNull();
      writeFileSync(path, JSON.stringify({ observers: null }));
      checksSinceWrite = 0;
      await waitUntil(() => closedAt >= 0, 5000);
      expect(closedAt).toBe(1);
      expect(closed).toEqual([4401]);
      expect(registry.liveScopes(K)).toBeNull();
    } finally {
      spy.mockRestore();
      registry.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the registry runs its hook after every check, and logs a hook that throws', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-hook-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [] });
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    let calls = 0;
    const registry = new ObserverRegistry(path, 20);
    try {
      registry.start(() => { calls++; throw new Error('hook'); });
      await waitUntil(() => calls >= 2);
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(lines.filter((l) => l === '[webui-observers] after a check: hook').length).toBe(calls);
  });

  test('the hook runs after the check, so it acts on the file as that check read it', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-hook-order-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health'] }] });
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    const registry = new ObserverRegistry(path, 20);
    let calls = 0;
    let revoked = false;
    const stale: number[] = [];
    try {
      registry.start(() => {
        calls++;
        if (revoked && registry.liveScopes(K) !== null) stale.push(calls);
      });
      await waitUntil(() => calls >= 2);
      saveObserversFile(path, { observers: [] });
      revoked = true; // in the same turn as the write, before any check can run
      const at = calls;
      await waitUntil(() => calls >= at + 3);
      expect(calls).toBeGreaterThanOrEqual(at + 3);
      expect(stale).toEqual([]);
      expect(registry.liveScopes(K)).toBeNull();
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit: scope filters + sessions
// ---------------------------------------------------------------------------

describe('scope filters', () => {
  const entry: WelcomeMessageEntry = {
    index: 0,
    participant: 'assistant',
    text: 'hi',
    blocks: [
      { kind: 'thinking', text: 'private' } as never,
      { kind: 'tool_use', id: 't1', name: 'shell', inputJson: '{}' } as never,
      { kind: 'tool_result', toolUseId: 't1', text: 'out' } as never,
      { kind: 'text', text: 'hi' } as never,
    ],
  };

  test('no messages scope → entry dropped entirely', () => {
    expect(filterEntryForScopes(entry, new Set<ObserverScope>(['health', 'ops']))).toBeNull();
  });

  test('messages without thinking/tools → those blocks elided', () => {
    const f = filterEntryForScopes(entry, new Set<ObserverScope>(['messages']))!;
    expect(f.blocks.map((b) => b.kind)).toEqual(['text']);
  });

  test('full interiority scopes → identical entry', () => {
    const f = filterEntryForScopes(entry, new Set<ObserverScope>(['messages', 'thinking', 'tools']));
    expect(f).toEqual(entry);
  });

  test('trace scope mapping', () => {
    expect(traceRequiredScope({ type: 'ops:alert' })).toBe('ops');
    expect(traceRequiredScope({ type: 'mcpl:server-closed' })).toBe('ops');
    expect(traceRequiredScope({ type: 'usage:updated' })).toBe('health');
    expect(traceRequiredScope({ type: 'inference:tokens', blockType: 'thinking' } as never)).toBe('thinking');
    expect(traceRequiredScope({ type: 'inference:tokens', blockType: 'tool_call' } as never)).toBe('tools');
    expect(traceRequiredScope({ type: 'inference:tokens', blockType: 'text' } as never)).toBe('messages');
    expect(traceRequiredScope({ type: 'tool:started' })).toBe('tools');
    expect(traceRequiredScope({ type: 'inference:completed' })).toBe('messages');
  });

  test('scopeWelcome without messages empties conversation payload', () => {
    const welcome = {
      type: 'welcome', protocolVersion: 1,
      messages: [entry],
      history: { startIndex: 40, totalCount: 240 },
      localTree: { asOfTs: 1, nodes: [{ secret: true }], callIdIndex: { a: 'b' } },
      childTrees: [{ name: 'c', asOfTs: 1, nodes: [], callIdIndex: {} }],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    } as unknown as WelcomeMessage;
    const w = scopeWelcome(welcome, new Set<ObserverScope>(['health', 'ops']));
    expect(w.messages).toEqual([]);
    expect(w.localTree.nodes).toEqual([]);
    expect(w.childTrees).toEqual([]);
    expect(w.history.startIndex).toBe(240);
    expect(w.usage.input).toBe(1); // structure/usage survive
  });

  // Health-gated telemetry must be masked exactly like its live frames:
  // `usage` and `call-ledger` pushes require the 'health' scope, so the
  // welcome cannot hand the same data to a messages-only observer.
  test('scopeWelcome without health strips callLedger/perAgentCost and zeroes usage', () => {
    const welcome = {
      type: 'welcome', protocolVersion: 1,
      messages: [entry],
      history: { startIndex: 40, totalCount: 240 },
      localTree: { asOfTs: 1, nodes: [], callIdIndex: {} },
      childTrees: [],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 5, currency: 'USD' } },
      perAgentCost: [{ name: 'main', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      callLedger: {
        calls: [{ model: 'secret-model', error: 'raw provider error', costUsd: 0.42 }],
      },
    } as unknown as WelcomeMessage;

    const w = scopeWelcome(welcome, new Set<ObserverScope>(['messages']));
    expect(w.callLedger).toBeUndefined();
    expect(w.perAgentCost).toBeUndefined();
    expect(w.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(w.messages.length).toBe(1); // messages scope still gets content
    // No trace of the ledger anywhere in the serialized frame.
    expect(JSON.stringify(w)).not.toContain('secret-model');
    expect(JSON.stringify(w)).not.toContain('raw provider error');

    // Same masking on the no-messages branch (e.g. ops-only observer).
    const opsOnly = scopeWelcome(welcome, new Set<ObserverScope>(['ops']));
    expect(opsOnly.callLedger).toBeUndefined();
    expect(opsOnly.perAgentCost).toBeUndefined();
    expect(opsOnly.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    // A health-scoped observer keeps the telemetry verbatim.
    const h = scopeWelcome(welcome, new Set<ObserverScope>(['health']));
    expect(h.callLedger).toEqual(welcome.callLedger);
    expect(h.perAgentCost).toEqual(welcome.perAgentCost);
    expect(h.usage).toEqual(welcome.usage);

    // Input welcome is never mutated (shared across clients in sendWelcome).
    expect(welcome.callLedger).toBeDefined();
    expect(welcome.usage.input).toBe(1);
  });
});

describe('ObserverSessions', () => {
  test('mint/lookup round-trip; bad token null; full flag carried', () => {
    const s = new ObserverSessions();
    const scopes = new Set<ObserverScope>(['health']);
    const live = () => new Set<ObserverScope>(['health', 'ops']);
    const token = s.mint(scopes, { key: 'k' });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect([...s.lookup(token, live)!.scopes]).toEqual(['health']);
    expect(s.lookup(token, live)!.full).toBe(false);
    expect(s.lookup('0'.repeat(64), live)).toBeNull();
    expect(s.lookup(null, live)).toBeNull();
    // Narrowing a session leaves the set it was minted with alone, which the hello's connection holds too.
    const wide = new Set<ObserverScope>(['health', 'ops']);
    const wideToken = s.mint(wide, { key: 'k' });
    expect([...s.lookup(wideToken, () => new Set<ObserverScope>(['health']))!.scopes]).toEqual(['health']);
    expect([...wide].sort()).toEqual(['health', 'ops']);

    // Full sessions (password sign-in path) carry operator authority.
    const fullToken = s.mint(new Set(), { full: true });
    expect(s.lookup(fullToken, live)!.full).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over a live module: empty grants → historical behavior; grant
// hot-appears → observer flow works.
// ---------------------------------------------------------------------------

const BASIC = `Basic ${Buffer.from('admin:pw').toString('base64')}`;

describe('WebUiModule observer flow (e2e)', () => {
  let tmp: string;
  let observersPath: string;
  let port: number;
  let mod: WebUiModule;
  const kp = makeKeypair();

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'webui-observers-'));
    const staticRoot = join(tmp, 'web');
    mkdirSync(staticRoot, { recursive: true });
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>t</title>');
    observersPath = join(tmp, 'observers.json');
    saveObserversFile(observersPath, { observers: [] }); // present but EMPTY

    mod = new WebUiModule({
      port: 0,
      host: '127.0.0.1',
      basicAuth: { username: 'admin', password: 'pw' },
      staticDir: staticRoot,
      observersPath,
    });
    await mod.start({} as ModuleContext);
    port = __getSharedServerPortForTests()!;
  });

  afterAll(async () => {
    await mod.stop();
    await __resetSharedServerForTests();
    rmSync(tmp, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${port}`;
  /** The static shell's status once it is `want`, or the last one seen when
   *  `ms` runs out: the registry's checks come on its own timer, which a
   *  loaded host can delay. */
  const shellStatusBecomes = async (want: number, ms = 12_000): Promise<number> => {
    const end = Date.now() + ms;
    for (;;) {
      const status = (await fetch(`${base()}/`)).status;
      if (status === want || Date.now() >= end) return status;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  test('no grants: static requires basic auth, unauthenticated WS upgrade 401', async () => {
    expect((await fetch(`${base()}/`)).status).toBe(401);
    const res = await fetch(`${base()}/ws`, {
      headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    expect(res.status).toBe(401);
  });

  test('grant appears (hot-reload): static public, observer WS flow end-to-end', async () => {
    saveObserversFile(observersPath, {
      observers: [{ key: kp.id, label: 'e2e-device', scopes: ['health', 'ops', 'debug'] }],
    });
    // The registry's next check, within about 3 s, admits it, and the static
    // app shell, which carries no data, is public from then on.
    expect(await shellStatusBecomes(200)).toBe(200);
    // But data routes still gated — including the credential state, scoped
    // to a fleet child or not (it can carry a pending device-code login).
    expect((await fetch(`${base()}/healthz`)).status).toBe(401);
    expect((await fetch(`${base()}/credential`)).status).toBe(401);
    expect((await fetch(`${base()}/credential?scope=child-a`)).status).toBe(401);

    // Unauthenticated WS: auth-required → signed hello → ack.
    const host = `127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://${host}/ws`);
    const frames: Record<string, unknown>[] = [];
    const got = (type: string) =>
      new Promise<Record<string, unknown>>((resolvePromise, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
        const check = () => {
          const f = frames.find((m) => m.type === type);
          if (f) { clearTimeout(t); resolvePromise(f); return true; }
          return false;
        };
        if (check()) return;
        ws.addEventListener('message', () => { check(); });
      });
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));

    const authReq = await got('observer-auth-required');
    expect(authReq.host).toBe(host);

    ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(kp, host) }));
    const ack = await got('observer-ack');
    expect(ack.label).toBe('e2e-device');
    expect((ack.scopes as string[]).sort()).toEqual(['debug', 'health', 'ops']);

    // Read-only: mutating messages are refused.
    ws.send(JSON.stringify({ type: 'user-message', content: 'hi' }));
    const errFrame = await got('error');
    expect(String(errFrame.message)).toContain('forbidden');

    // Branch listing rides the 'messages' scope, which this grant lacks.
    ws.send(JSON.stringify({ type: 'request-branches' }));
    const branchErr = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for request-branches refusal')), 5000);
      const check = () => {
        const f = frames.find((m) => m.type === 'error' && String(m.message).includes('request-branches'));
        if (f) { clearTimeout(t); resolvePromise(f); return true; }
        return false;
      };
      if (check()) return;
      ws.addEventListener('message', () => { check(); });
    });
    expect(String(branchErr.message)).toContain('forbidden');

    // Session cookie: ordinary debug is allowed by scope, but retrieval traces
    // remain operator-only because they can expose lessons and opt-in inputs.
    const cookie = `fkm_obs=${ack.sessionToken}`;
    // 503 means authorization passed but this harness has no bound app.
    expect((await fetch(`${base()}/healthz`, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(`${base()}/credential`, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(`${base()}/debug/context`, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(`${base()}/debug/retrieval`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${base()}/debug/retrieval/view`, { headers: { cookie } })).status).toBe(401);
    // Basic auth still works for everything.
    expect((await fetch(`${base()}/healthz`, { headers: { authorization: BASIC } })).status).toBe(503);

    ws.close();
  }, 25_000);

  test('password sign-in mints a full-session cookie the WS upgrade honors', async () => {
    // /auth/basic with valid credentials → 302 + full-session cookie.
    const res = await fetch(`${base()}/auth/basic`, { headers: { authorization: BASIC }, redirect: 'manual' });
    expect(res.status).toBe(302);
    const m = /fkm_obs=([a-f0-9]{64})/.exec(res.headers.get('set-cookie') ?? '');
    expect(m).not.toBeNull();

    // A WS upgrade carrying ONLY the cookie (no Authorization — the Chrome
    // situation) must be treated as a FULL client: no observer-auth-required
    // demand. (Full clients are parked silently in this app-less harness;
    // the observer path would send auth-required immediately.)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `fkm_obs=${m![1]}` } } as never);
    const firstFrame = await Promise.race([
      new Promise<string>((r) => ws.addEventListener('message', (ev) => r(String((ev as MessageEvent).data)))),
      new Promise<string>((r) => setTimeout(() => r('SILENCE'), 1500)),
    ]);
    ws.close();
    expect(firstFrame).toBe('SILENCE'); // not observer-auth-required
  }, 10_000);

  test('wrong key: hello rejected and socket closed', async () => {
    const stranger = makeKeypair();
    const host = `127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://${host}/ws`);
    const closed = new Promise<number>((r) => ws.addEventListener('close', (ev) => r(ev.code)));
    // An upgrade refused (no grant active yet) closes without opening; say so
    // rather than wait for an open that won't come.
    const opened = await new Promise<boolean>((r) => {
      ws.addEventListener('open', () => r(true));
      ws.addEventListener('close', () => r(false));
    });
    expect(opened).toBe(true);
    ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(stranger, host) }));
    expect(await closed).toBe(4401);
  }, 10_000);

  // It takes the grants away; the case after it writes its own.
  test('file removed (hot-reload): the static shell needs the password again', async () => {
    expect((await fetch(`${base()}/`)).status).toBe(200);
    rmSync(observersPath);
    // Two checks 3 s apart take the grants away.
    expect(await shellStatusBecomes(401)).toBe(401);
  }, 20_000);

  test("an observer whose socket can't be closed is dropped as a close drops it: its peek, its place among the clients, and anything more sent", async () => {
    const kp4 = makeKeypair();
    const host = `127.0.0.1:${port}`;
    const id = 900_001;
    const sent: string[] = [];
    const fakeWs = {
      data: { id, authed: false, host },
      send: (s: string) => { sent.push(s); return s.length; },
      close: () => { throw new Error('socket'); },
    };
    const m = mod as unknown as { onWsOpen(ws: unknown): void; onWsMessage(ws: unknown, msg: string): void; send(client: unknown, msg: unknown): void };
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      saveObserversFile(observersPath, { observers: [{ key: kp4.id, label: 'unclosable', scopes: ['health'] }] });
      expect(await shellStatusBecomes(200)).toBe(200);
      m.onWsOpen(fakeWs);
      m.onWsMessage(fakeWs, JSON.stringify({ type: 'observer-hello', identity: helloFor(kp4, host) }));
      await waitUntil(() => sent.some((s) => (JSON.parse(s) as { type: string }).type === 'observer-ack'), 5000);
      const clients = __getSharedServerClientsForTests()!;
      const client = clients.get(id) as { auth: string; peeks: Map<string, () => void> };
      expect(client.auth).toBe('observer');
      let detached = false;
      client.peeks.set('scout', () => { detached = true; });
      const before = sent.length;

      saveObserversFile(observersPath, { observers: [] });
      await waitUntil(() => !clients.has(id), 8000);
      expect(clients.has(id)).toBe(false);
      expect(detached).toBe(true);
      expect(lines).toContain("[webui-observers] observer connection couldn't be closed: unclosable (socket); it gets nothing more");
      // Whatever was in flight for it, such as a welcome past its await or a
      // reply, goes through send(), which now sends it nothing.
      m.send(client, { type: 'error', message: 'late' });
      expect(sent.length).toBe(before);
      // What it sends finds no client, so nothing answers it: a hello here
      // would otherwise be refused with an error, since no grant is left.
      m.onWsMessage(fakeWs, JSON.stringify({ type: 'observer-hello', identity: helloFor(kp4, host) }));
      await new Promise((r) => setTimeout(r, 50));
      expect(sent.length).toBe(before);
    } finally {
      spy.mockRestore();
      saveObserversFile(observersPath, { observers: [] });
      await shellStatusBecomes(401);
    }
  }, 30_000);

  test('a session the check narrowed stays narrowed when the grant is widened again, though it was not used between', async () => {
    const kp3 = makeKeypair();
    const host = `127.0.0.1:${port}`;
    const sockets: WebSocket[] = [];
    // Says hello on a new socket and resolves with the ack and the socket's close code.
    const connect = async () => {
      const ws = new WebSocket(`ws://${host}/ws`);
      sockets.push(ws);
      const frames: Record<string, unknown>[] = [];
      ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
      const closed = new Promise<number>((r) => ws.addEventListener('close', (ev) => r(ev.code)));
      const frame = async (type: string) => {
        await waitUntil(() => frames.some((m) => m.type === type), 5000);
        const f = frames.find((m) => m.type === type);
        if (!f) throw new Error(`timeout waiting for ${type}`);
        return f;
      };
      await frame('observer-auth-required');
      ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(kp3, host) }));
      return { ack: await frame('observer-ack'), closed };
    };
    const debug = async (cookie: string) => (await fetch(`${base()}/debug/state`, { headers: { cookie } })).status;
    // Whether the static shell is served without the password: some grant is in.
    const shellOpen = async () => (await fetch(`${base()}/`)).status === 200;
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      saveObserversFile(observersPath, { observers: [{ key: kp3.id, label: 'narrowed', scopes: ['health', 'debug'] }] });
      // The next check admits it: the static shell no longer asks for the password.
      for (const end = Date.now() + 8000; !(await shellOpen()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
      const kept = await connect();
      expect(kept.ack.scopes).toEqual(['health', 'debug']);
      const keptCookie = `fkm_obs=${kept.ack.sessionToken}`;

      // Narrowed at a check, while nothing uses the kept session.
      saveObserversFile(observersPath, { observers: [{ key: kp3.id, label: 'narrowed', scopes: ['health'] }] });
      expect(await kept.closed).toBe(4403);

      // Widened again: a new hello gets debug back once a check reads it,
      // and until then gets the narrowed grant.
      saveObserversFile(observersPath, { observers: [{ key: kp3.id, label: 'narrowed', scopes: ['health', 'debug'] }] });
      let fresh = await connect();
      for (const end = Date.now() + 8000; !(fresh.ack.scopes as string[]).includes('debug') && Date.now() < end;) {
        expect(fresh.ack.scopes).toEqual(['health']);
        await new Promise((r) => setTimeout(r, 200));
        fresh = await connect();
      }
      expect(fresh.ack.scopes).toEqual(['health', 'debug']);
      expect(await debug(`fkm_obs=${fresh.ack.sessionToken}`)).not.toBe(401);

      // The kept session, first used now, stays as the check narrowed it:
      // refused debug, and still past the health gate it kept, which answers
      // 503 here with no app, where an ended session would get 401.
      expect(await debug(keptCookie)).toBe(401);
      expect((await fetch(`${base()}/healthz`, { headers: { cookie: keptCookie } })).status).toBe(503);
    } finally {
      for (const ws of sockets) ws.close();
      // Leave the file with no grants, as the next case expects, once a check has read it.
      saveObserversFile(observersPath, { observers: [] });
      for (const end = Date.now() + 8000; (await shellOpen()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
      spy.mockRestore();
    }
  }, 40_000);

  test('narrowing a grant closes its socket (4403) and narrows its cookie; revoking it closes the socket (4401) and ends the cookie', async () => {
    const kp2 = makeKeypair();
    const host = `127.0.0.1:${port}`;
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    // Says hello on a new socket and resolves with the ack and the socket's close code.
    const connect = async () => {
      const ws = new WebSocket(`ws://${host}/ws`);
      const frames: Record<string, unknown>[] = [];
      ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
      const closed = new Promise<number>((r) => ws.addEventListener('close', (ev) => r(ev.code)));
      const frame = async (type: string) => {
        await waitUntil(() => frames.some((m) => m.type === type), 5000);
        const f = frames.find((m) => m.type === type);
        if (!f) throw new Error(`timeout waiting for ${type}`);
        return f;
      };
      await frame('observer-auth-required');
      ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(kp2, host) }));
      return { ack: await frame('observer-ack'), closed };
    };
    const healthz = async (cookie: string) => (await fetch(`${base()}/healthz`, { headers: { cookie } })).status;
    const debug = async (cookie: string) => (await fetch(`${base()}/debug/state`, { headers: { cookie } })).status;
    try {
      saveObserversFile(observersPath, { observers: [{ key: kp2.id, label: 'to-revoke', scopes: ['health', 'debug'] }] });
      // The next check admits it: the static shell no longer asks for the password.
      const shellOpen = async () => (await fetch(`${base()}/`)).status === 200;
      for (const end = Date.now() + 8000; !(await shellOpen()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));

      const first = await connect();
      const cookie = `fkm_obs=${first.ack.sessionToken}`;
      expect(await healthz(cookie)).toBe(503);
      expect(await debug(cookie)).not.toBe(401);

      saveObserversFile(observersPath, { observers: [{ key: kp2.id, label: 'to-revoke', scopes: ['health'] }] });
      expect(await first.closed).toBe(4403);
      expect(await healthz(cookie)).toBe(503);
      expect(await debug(cookie)).toBe(401);
      const second = await connect();
      expect(second.ack.scopes).toEqual(['health']);

      saveObserversFile(observersPath, { observers: [] });
      expect(await second.closed).toBe(4401);
      expect(await healthz(cookie)).toBe(401);
      expect(lines.filter((l) => l.startsWith('[webui-observers] closed '))).toEqual([
        '[webui-observers] closed 1 observer connection(s) whose grant is gone, expired or narrowed, and ended 0 observer session(s) whose grant is gone, expired or keeps none of their scopes',
        '[webui-observers] closed 1 observer connection(s) whose grant is gone, expired or narrowed, and ended 2 observer session(s) whose grant is gone, expired or keeps none of their scopes',
      ]);

      // The second cookie wasn't used while the grant was gone. It ended at
      // that check all the same, and granting the key again doesn't bring it back.
      saveObserversFile(observersPath, { observers: [{ key: kp2.id, label: 'to-revoke', scopes: ['health'] }] });
      for (const end = Date.now() + 8000; !(await shellOpen()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
      expect(await shellOpen()).toBe(true);
      expect(await healthz(`fkm_obs=${second.ack.sessionToken}`)).toBe(401);
    } finally { spy.mockRestore(); }
  }, 40_000);
});
