// Identity module (archipelago-home client) + the tools↔utilities surface
// flags on mcpl-admin and observers. See docs/home-node.md §4 and the af
// utils meta-tool (Module.getUtilities).
//
// Design under test: the AGENT surface is credential-free (status /
// accept_invite, no tokens in any result); credentials exist only on the
// HOST-facing API (accessFor/httpAuthFor) that the MCPL dial provider
// and HTTP helpers consume outside model context.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '@animalabs/agent-framework';

import { IdentityModule } from '../src/modules/identity-module.ts';
import { McplAdminModule } from '../src/modules/mcpl-admin-module.ts';
import { ObserversModule } from '../src/modules/observers-module.ts';

const REQUEST_BODY_MAX_FOR_TEST = 256 * 1024;
const call = (name: string, input: unknown) => ({ id: 't1', name, input });

function fakeHome(routes: Record<string, (body: any) => { status: number; json: unknown }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const handler = routes[path];
    if (!handler) return new Response('{}', { status: 404 });
    const body = JSON.parse(String(init?.body ?? '{}'));
    const { status, json } = handler(body);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
}

describe('identity module', () => {
  it('is utilities-only, and the agent surface never mentions or returns credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const mod = new IdentityModule({ keyPath: join(dir, 'identity-key.pem'), home: 'id.test' });
    expect(mod.getTools()).toEqual([]);
    expect(mod.getUtilities().map((u) => u.name)).toEqual(['status', 'request', 'accept_invite']);
    // Framing check: no crypto/credential vocabulary in agent-visible text.
    const visible = JSON.stringify(mod.getUtilities()).toLowerCase();
    for (const scary of ['token', 'key', 'sign', 'proof', 'ed25519', 'mint', 'bearer']) {
      expect(visible).not.toContain(scary);
    }

    const res = await mod.handleToolCall(call('status', {}));
    expect(res.success).toBe(true);
    const data = res.data as { registeredAs: unknown; note: string };
    expect(data.registeredAs).toBe(null);
    expect(data.note).toContain('invitation code');
    expect(JSON.stringify(res.data)).not.toContain('ed25519'); // key exists on disk, not in results
    expect(existsSync(join(dir, 'identity-key.pem'))).toBe(true);
  });

  it('accept_invite registers, echoes NO credential, and is one-time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    let seen: any = null;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      fetchImpl: fakeHome({
        '/enroll': (body) => {
          seen = body;
          return { status: 200, json: { sub: 'agent:ferro@guest', token: 'aid1.SECRET.x' } };
        },
      }),
    });
    const res = await mod.handleToolCall(call('accept_invite', { invite: 'inv_1', name: 'Ferro' }));
    expect(res.success).toBe(true);
    expect((res.data as any).id).toBe('agent:ferro@guest');
    // The home node's response token must NOT reach the agent.
    expect(JSON.stringify(res.data)).not.toContain('aid1.');

    // Wire-level: the signed statement is the spec's, verifiable by the module's own key.
    const raw = Buffer.from(seen.id.slice('ed25519:'.length), 'base64url');
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der', type: 'spki',
    });
    const statement = `archipelago-enroll|v1|id.test|inv_1|${seen.timestamp}`;
    expect(cryptoVerify(null, Buffer.from(statement), key, Buffer.from(seen.proof, 'base64url'))).toBe(true);

    const rec = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'));
    expect(rec.sub).toBe('agent:ferro@guest');

    const again = await mod.handleToolCall(call('accept_invite', { invite: 'inv_2', name: 'Ferro2' }));
    expect(again.success).toBe(false);
    expect(again.error).toContain('Nothing changed: this host is already registered as "Ferro"');
  });


  it('request: allowlisted service, host-attached access, no credential in result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    let authSeen = '';
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { orrery: 'https://orrery.test' },
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@guest', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u === 'https://orrery.test/api/ops') {
          authSeen = String(init?.headers?.authorization ?? '');
          return new Response(JSON.stringify({ ops: [1, 2] }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    // not registered yet -> neutral failure
    const early = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/ops' }));
    expect(early.success).toBe(false);

    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    const res = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/ops' }));
    expect(res.success).toBe(true);
    expect((res.data as any).status).toBe(200);
    expect((res.data as any).body).toEqual({ ops: [1, 2] });
    expect(authSeen).toBe('Bearer aid1.fresh.secret');
    // the credential must never appear in the agent-visible result
    expect(JSON.stringify(res.data)).not.toContain('aid1.');

    const unknown = await mod.handleToolCall(call('request', { service: 'nope', path: '/x' }));
    expect(unknown.error).toContain('Nothing was sent: there\'s no service "nope" here.');
    expect(unknown.error).toContain('orrery');
    const badPath = await mod.handleToolCall(call('request', { service: 'orrery', path: 'api/ops' }));
    expect(badPath.success).toBe(false);
  });

  it('request: services come from the home node directory, and a newly-listed one works without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    // The archipelago's service list lives at the home node, not in this host.
    // It changes underneath us mid-run: `music` is added after the module has
    // already fetched and cached a directory without it.
    let directory: Record<string, string> = { orrery: 'https://orrery.test' };
    let directoryFetches = 0;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@id.test', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u === 'https://id.test/services') {
          directoryFetches++;
          return new Response(JSON.stringify({ home: 'id.test', services: directory }), { status: 200 });
        }
        if (u === 'https://music.test/api/me') return new Response(JSON.stringify({ me: 'mythos' }), { status: 200 });
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));

    // nothing compiled in, nothing in the recipe: the directory supplied it
    const listed = await mod.handleToolCall(call('request', { service: 'orrery', path: '/x' }));
    expect(listed.success).toBe(true); // resolved and called; upstream 404 is reported, not a resolution failure
    expect((listed.data as any).status).toBe(404);

    // music does not exist yet -> refused, and the refusal cost a re-check
    const before = await mod.handleToolCall(call('request', { service: 'music', path: '/api/me' }));
    expect(before.success).toBe(false);
    expect(before.error).toContain('there\'s no service "music"');

    // operator adds it at the home node; no restart, no recipe edit here
    directory = { orrery: 'https://orrery.test', music: 'https://music.test' };
    const fetchesBefore = directoryFetches;

    const after = await mod.handleToolCall(call('request', { service: 'music', path: '/api/me' }));
    expect(after.success).toBe(true);
    expect((after.data as any).body).toEqual({ me: 'mythos' });
    // it re-asked rather than serving a stale "unknown" from cache
    expect(directoryFetches).toBeGreaterThan(fetchesBefore);
  });

  it('request: a home node that cannot be reached degrades to the built-in map, never to an outage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      fetchImpl: (async (url: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@id.test', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u === 'https://id.test/services') return new Response('nope', { status: 503 });
        if (u === 'https://eidoverse.animalabs.ai/api/ping') return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    const res = await mod.handleToolCall(call('request', { service: 'eidoverse', path: '/api/ping' }));
    expect(res.success).toBe(true);
    expect((res.data as any).body).toEqual({ ok: true });
  });

  it('request: fromFile uploads a workspace file byte-exactly, without the bytes touching context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    // A file far larger than the JSON body cap — the case that made this exist.
    const audio = Buffer.alloc(REQUEST_BODY_MAX_FOR_TEST + 4096, 0);
    audio.write('ID3', 0);
    audio[audio.length - 1] = 0x7f;
    let sentBody: Buffer | null = null;
    let sentType = '';
    // The resident wrote the file through the workspace, and disk has no copy.
    const workspace = {
      readFileFromDisk: async (path: string) => { throw new WorkspaceReadError('not_found', `File not found: ${path}`, 'lstat', 'ENOENT'); },
      readBinary: async (path: string) =>
        path === 'files/music/track.mp3' ? { data: audio } : { error: `File not found: ${path}` },
      writeBinary: async () => ({ success: true }),
    };
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { music: 'https://music.test' },
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@id.test', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u.includes('/services')) return new Response(JSON.stringify({ services: {} }), { status: 200 });
        if (u === 'https://music.test/api/upload/1/audio') {
          sentBody = Buffer.from(init?.body as Uint8Array);
          sentType = String(init?.headers?.['content-type'] ?? '');
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    (mod as any).ctx = { getModule: (n: string) => (n === 'workspace' ? workspace : null) };
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));

    const res = await mod.handleToolCall(
      call('request', { service: 'music', path: '/api/upload/1/audio', method: 'PUT', fromFile: 'files/music/track.mp3' }),
    );
    expect(res.success).toBe(true);
    // byte-exact, and typed from the extension rather than guessed by the model
    expect(sentBody!.equals(audio)).toBe(true);
    expect(sentType).toBe('audio/mpeg');
    // a receipt, but never the payload itself, in the agent-visible result,
    // naming the copy that went
    expect((res.data as any).sent).toEqual({
      path: 'files/music/track.mp3',
      size: audio.byteLength,
      contentType: 'audio/mpeg',
      from: 'the workspace, since disk has no file at this path',
    });
    expect(JSON.stringify(res.data).length).toBeLessThan(1000);

    // guard rails
    const both = await mod.handleToolCall(
      call('request', { service: 'music', path: '/x', method: 'PUT', body: { a: 1 }, fromFile: 'files/music/track.mp3' }),
    );
    expect(both.error).toContain('not both');
    const onGet = await mod.handleToolCall(call('request', { service: 'music', path: '/x', fromFile: 'files/music/track.mp3' }));
    expect(onGet.error).toContain('needs a method that sends a body');
    const missing = await mod.handleToolCall(
      call('request', { service: 'music', path: '/x', method: 'PUT', fromFile: 'files/nope.mp3' }),
    );
    expectSays(missing.error, 'Nothing was sent to "music"', '"files/nope.mp3" couldn\'t be read');
  });

  it('request: every writing method carries a JSON body or a workspace file; GET carries neither', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);
    const sent: Array<{ url: string; method: string; type: string; auth: string; body: unknown }> = [];
    const workspace = {
      readFileFromDisk: async (path: string) => {
        if (path === 'files/artifacts/grid.png') return { bytes: png, size: png.byteLength, truncated: false };
        throw new WorkspaceReadError('not_found', `File not found: ${path}`, 'lstat', 'ENOENT');
      },
      readBinary: async (path: string) =>
        path === 'files/artifacts/grid.png' ? { data: png } : { error: `File not found: ${path}` },
      writeBinary: async () => ({ success: true }),
    };
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { orrery: 'https://orrery.test' },
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@id.test', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u.includes('/services')) return new Response(JSON.stringify({ services: {} }), { status: 200 });
        if (u.startsWith('https://orrery.test/api/nodes/')) {
          sent.push({
            url: u,
            method: String(init?.method),
            type: String(init?.headers?.['content-type'] ?? ''),
            auth: String(init?.headers?.authorization ?? ''),
            body: init?.body instanceof Uint8Array ? Buffer.from(init.body) : init?.body,
          });
          // An empty 204, as PATCH and DELETE routes often answer.
          if (u.endsWith('/empty')) return new Response(null, { status: 204 });
          return new Response(JSON.stringify({ id: 'n1', starred: true, note: 'the open ring' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    (mod as any).ctx = { getModule: (n: string) => (n === 'workspace' ? workspace : null) };
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));

    // The framework's `utils run` checks args against the advertised enum
    // before the handler runs, so the schema has to offer every verb.
    const request = mod.getUtilities().find((u) => u.name === 'request')!;
    const methods = (request.inputSchema.properties as any).method.enum as string[];
    expect(methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      // A JSON body, as orrery's PATCH-only node update takes one.
      const withBody = await mod.handleToolCall(call('request', {
        service: 'orrery', path: '/api/nodes/n1', method, body: { starred: true, note: 'the open ring' },
      }));
      expect(withBody.success).toBe(true);
      expect(withBody.data).toEqual({ status: 200, body: { id: 'n1', starred: true, note: 'the open ring' } });
      expect(sent.at(-1)).toEqual({
        url: 'https://orrery.test/api/nodes/n1',
        method,
        type: 'application/json',
        auth: 'Bearer aid1.fresh.secret',
        body: JSON.stringify({ starred: true, note: 'the open ring' }),
      });
      expect(JSON.stringify(withBody.data)).not.toContain('aid1.');

      // A workspace file's bytes, byte-exactly, with the upload receipt.
      const withFile = await mod.handleToolCall(call('request', {
        service: 'orrery', path: '/api/nodes/n1', method, fromFile: 'files/artifacts/grid.png',
      }));
      expect(withFile.success).toBe(true);
      expect((withFile.data as any).sent).toEqual({ path: 'files/artifacts/grid.png', size: png.byteLength, contentType: 'image/png', from: 'disk' });
      expect(sent.at(-1)).toMatchObject({ method, type: 'image/png', auth: 'Bearer aid1.fresh.secret' });
      expect(Buffer.isBuffer(sent.at(-1)!.body) && (sent.at(-1)!.body as Buffer).equals(png)).toBe(true);
      expect(JSON.stringify(withFile.data)).not.toContain('aid1.');
    }
    expect(sent.length).toBe(8);

    // A writing method with neither body nor file sends neither, and no type.
    const bare = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/nodes/n1', method: 'PATCH' }));
    expect(bare.success).toBe(true);
    expect(sent.at(-1)).toEqual({ url: 'https://orrery.test/api/nodes/n1', method: 'PATCH', type: '', auth: 'Bearer aid1.fresh.secret', body: undefined });

    // An empty 204 is an empty success, with no advice to repeat the write.
    const empty = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/nodes/empty', method: 'DELETE',
    }));
    expect(empty.success).toBe(true);
    expect(empty.data).toEqual({ status: 204, body: '' });
    expect(sent.length).toBe(10);

    // Refused before the wire: a body or a file with GET, whether GET was
    // given or defaulted; body with fromFile; an unlisted verb.
    for (const input of [
      { method: 'GET', body: { starred: true } },
      { body: { starred: true } },
      { method: 'GET', fromFile: 'files/artifacts/grid.png' },
      { fromFile: 'files/artifacts/grid.png' },
    ]) {
      const refused = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/nodes/n1', ...input }));
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('needs a method that sends');
      expect(refused.error).toContain('POST, PUT, PATCH, DELETE');
      expect(refused.error).toContain(input.method ? 'method is GET' : 'method is GET by default');
    }
    const both = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/nodes/n1', method: 'PATCH', body: { starred: true }, fromFile: 'files/artifacts/grid.png',
    }));
    expect(both.success).toBe(false);
    expect(both.error).toContain('not both');
    expect(methods).not.toContain('TRACE');
    const trace = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/nodes/n1', method: 'TRACE' }));
    expect(trace.success).toBe(false);
    expect(trace.error).toContain('Nothing was sent: method "TRACE" isn\'t one this utility sends. Use GET, POST, PUT, PATCH or DELETE.');
    expect(sent.length).toBe(10);
  });

  it('request: binary responses are described safely or saved byte-exactly to workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);
    let saved: { path: string; data: Buffer; mime: string } | null = null;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { orrery: 'https://orrery.test' },
      fetchImpl: (async (url: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u === 'https://orrery.test/api/assets/img/file') {
          return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));

    const described = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/assets/img/file' }));
    expect(described.success).toBe(true);
    expect((described.data as any).body).toBe(null);
    expect((described.data as any).binary).toMatchObject({ size: png.length, contentType: 'image/png' });
    expect(JSON.stringify(described.data)).not.toContain('�PNG');

    await mod.start({
      getModule: (name: string) => name === 'workspace' ? {
        writeBinary: async (path: string, data: Buffer, mime: string) => {
          saved = { path, data: Buffer.from(data), mime };
          return { success: true, data: { path, size: data.length, mimeType: mime } };
        },
      } : null,
    } as any);
    const written = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/assets/img/file', saveAs: 'files/artifacts/candidate.png',
    }));
    expect(written.success).toBe(true);
    expect((written.data as any).saved).toMatchObject({
      path: 'files/artifacts/candidate.png', size: png.length, contentType: 'image/png',
    });
    expect(saved?.path).toBe('files/artifacts/candidate.png');
    expect(saved?.mime).toBe('image/png');
    expect(saved?.data.equals(png)).toBe(true);
  });

  it('host-facing accessFor: requires registration, then exchanges per call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    let mints = 0;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      defaultAudience: 'eidoverse',
      fetchImpl: fakeHome({
        '/enroll': () => ({ status: 200, json: { sub: 'agent:a@guest', token: 't0' } }),
        '/token': (body) => body.audience === 'eidoverse'
          ? { status: 200, json: { token: `aid1.fresh.${++mints}` } }
          : { status: 400, json: { error: 'unknown audience' } },
      }),
    });
    await expect(mod.accessFor()).rejects.toThrow(/isn't registered with the identity service at id\.test/);

    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    expect(await mod.accessFor()).toBe('aid1.fresh.1');
    expect(await mod.accessFor('eidoverse')).toBe('aid1.fresh.2'); // fresh per call — dial-time rotation
    expect((await mod.httpAuthFor()).authorization).toBe('Bearer aid1.fresh.3');
    await expect(mod.accessFor('nope')).rejects.toThrow(/unknown audience/);
    expect(mod.isEnrolled()).toBe(true);
    expect(mod.sub()).toBe('agent:a@guest');
  });
});

/** That `text` says each thing the agent needs, whatever words surround it. */
function expectSays(text: unknown, ...parts: string[]): void {
  for (const part of parts) expect(String(text)).toContain(part);
}

/**
 * An identity module registered with a fake identity service, its `/token`
 * and `/enroll` answers chosen per test, and one service, orrery, whose
 * answer the test chooses too. `seen` counts the calls that reached orrery.
 */
function registeredModule(opts: {
  token?: () => Response;
  enroll?: () => Response;
  orrery?: (init?: RequestInit) => Response | Promise<Response>;
  workspace?: unknown;
  register?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ident-'));
  const seen = { orrery: 0 };
  const mod = new IdentityModule({
    keyPath: join(dir, 'k.pem'),
    home: 'id.test',
    services: { orrery: 'https://orrery.test' },
    fetchImpl: (async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/services')) return new Response(JSON.stringify({ services: {} }), { status: 200 });
      if (u.includes('/enroll')) return opts.enroll?.() ?? new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
      if (u.includes('/token')) return opts.token?.() ?? new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
      if (u.startsWith('https://orrery.test/')) {
        seen.orrery++;
        return opts.orrery?.(init) ?? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch,
  });
  if (opts.workspace !== undefined) (mod as any).ctx = { getModule: (n: string) => (n === 'workspace' ? opts.workspace : null) };
  return { mod, dir, seen, ready: opts.register === false ? Promise.resolve() : mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' })) };
}

describe('identity: what the agent reads when a call fails', () => {
  // The workspace's copy stands in for a file disk doesn't have, and a file
  // that's on disk but can't be read there is refused: an upload never sends
  // a copy that may differ from disk's without saying so.
  describe('fromFile', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // What agent-framework's readFileFromDisk throws where disk has no file.
    const notOnDisk = (errno = 'ENOENT') => new WorkspaceReadError('not_found', 'File not found: files/grid.png', 'lstat', errno);
    const workspaceFor = (disk: WorkspaceReadError | null, storeError: string | null = null) => {
      const calls = { store: 0 };
      return {
        calls,
        readFileFromDisk: async () => {
          if (disk) throw disk;
          return { bytes: png, size: png.byteLength, truncated: false };
        },
        readBinary: async () => { calls.store++; return storeError === null ? { data: png } : { error: storeError }; },
        writeBinary: async () => ({ success: true }),
      };
    };
    const upload = (mod: IdentityModule) =>
      mod.handleToolCall(call('request', { service: 'orrery', path: '/api/up', method: 'PUT', fromFile: 'files/grid.png' }));

    it("sends disk's copy, and says so", async () => {
      const { mod, ready } = registeredModule({ workspace: workspaceFor(null) });
      await ready;
      expect(((await upload(mod)).data as any).sent.from).toBe('disk');
    });

    it("sends the workspace's copy of a file disk doesn't have, and says it was the workspace's", async () => {
      const ws = workspaceFor(notOnDisk());
      const { mod, ready, seen } = registeredModule({ workspace: ws });
      await ready;
      const res = await upload(mod);
      expect(res.success).toBe(true);
      expect((res.data as any).sent.from).toBe('the workspace, since disk has no file at this path');
      expect(seen.orrery).toBe(1);
    });

    it("refuses a file disk can't read, naming disk's reason, and sends nothing", async () => {
      const ws = workspaceFor(new WorkspaceReadError('not_found', 'Unable to read file: files/grid.png', 'open', 'EACCES'));
      const { mod, ready, seen } = registeredModule({ workspace: ws });
      await ready;
      const res = await upload(mod);
      expectSays(
        res.error, 'Nothing was sent to "orrery"', '"files/grid.png" couldn\'t be read from disk',
        'the workspace\'s copy wasn\'t sent in its place', 'On disk: Unable to read file: files/grid.png (EACCES).',
      );
      expect(ws.calls.store).toBe(0);
      expect(seen.orrery).toBe(0);
    });

    // The disk read checks the size before it reads, and a file can grow in between.
    it("holds the upload limit on what the disk read returns", async () => {
      const ws = {
        ...workspaceFor(null),
        readFileFromDisk: async () => ({ bytes: { byteLength: 64 * 1024 * 1024 + 1 } as Buffer, size: 8, truncated: false }),
      };
      const { mod, ready, seen } = registeredModule({ workspace: ws });
      await ready;
      expectSays((await upload(mod)).error, 'Nothing was sent to "orrery"', 'over the 67108864-byte upload limit');
      expect(seen.orrery).toBe(0);
    });

    it('gives a reason both reads share once, and each where they differ', async () => {
      const same = registeredModule({ workspace: workspaceFor(notOnDisk(), 'File not found: files/grid.png') });
      await same.ready;
      expect((await upload(same.mod)).error).toBe('Nothing was sent to "orrery": "files/grid.png" couldn\'t be read. File not found: files/grid.png.');
      const differ = registeredModule({ workspace: workspaceFor(notOnDisk('ENOTDIR'), 'Blob not found for: files/grid.png') });
      await differ.ready;
      expect((await upload(differ.mod)).error).toBe(
        'Nothing was sent to "orrery": "files/grid.png" couldn\'t be read. On disk: File not found: files/grid.png (ENOTDIR). ' +
        'In the workspace: Blob not found for: files/grid.png.',
      );
    });

    it('says which copy went whatever the response: saved with saveAs, or binary', async () => {
      const { mod, ready } = registeredModule({
        workspace: workspaceFor(null),
        orrery: () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
      });
      await ready;
      const saved = await mod.handleToolCall(call('request', {
        service: 'orrery', path: '/api/up', method: 'PUT', fromFile: 'files/grid.png', saveAs: 'files/thumb.png',
      }));
      expect((saved.data as any).saved.path).toBe('files/thumb.png');
      expect((saved.data as any).saved.diskCopyError).toBeUndefined();
      expect((saved.data as any).sent).toMatchObject({ path: 'files/grid.png', from: 'disk' });
      const binary = await upload(mod);
      expect((binary.data as any).binary.contentType).toBe('image/png');
      expect((binary.data as any).sent).toMatchObject({ path: 'files/grid.png', from: 'disk' });
    });
  });

  // Sending a write again would repeat it, so only a GET's note says to.
  it("doesn't advise sending a write again to keep its binary response", async () => {
    const { mod, ready } = registeredModule({
      orrery: () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    await ready;
    const write = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/render', method: 'POST', body: {} }));
    expectSays((write.data as any).binary.note, 'sending this POST again with `saveAs` would repeat it', 'pass `saveAs` with the write itself');
    expect((write.data as any).binary.note).not.toContain('repeat the request');
    const read = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/render' }));
    expectSays((read.data as any).binary.note, 'repeat the request with saveAs');
  });

  it("refuses saveAs with no workspace before anything is sent", async () => {
    const { mod, ready, seen } = registeredModule();
    await ready;
    const res = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x', method: 'POST', body: {}, saveAs: 'files/x.json' }));
    expectSays(res.error, 'Nothing was sent', '`saveAs` writes the response to the workspace', 'Leave `saveAs` out');
    expect(seen.orrery).toBe(0);
  });

  it('tells a request that got no reply from one whose reply came back but couldn\'t be read or saved', async () => {
    const noReply = registeredModule({ orrery: () => { throw new Error('connection reset'); } });
    await noReply.ready;
    const write = await noReply.mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x', method: 'POST', body: {} }));
    expectSays(write.error, 'got no reply: connection reset.', 'Whether it reached the service is unknown', 'check whether the POST took effect');
    const read = await noReply.mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }));
    expectSays(read.error, 'got no reply', 'a GET only reads, so it can be sent again');

    const cut = registeredModule({
      orrery: () => new Response(new ReadableStream({ start(c) { c.error(new Error('stream cut')); } }), { status: 201 }),
    });
    await cut.ready;
    const cutWrite = await cut.mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x', method: 'PATCH', body: {} }));
    expectSays(
      cutWrite.error, 'The request to "orrery" went through (status 201), but its response couldn\'t be read or kept',
      'Anything the PATCH changed on the service stays changed',
    );

    const unsaved = registeredModule({ workspace: { writeBinary: async () => ({ success: false, error: 'Mount "files" is read-only' }) } });
    await unsaved.ready;
    const saved = await unsaved.mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/x', method: 'POST', body: {}, saveAs: 'files/out.json',
    }));
    expectSays(
      saved.error, 'went through (status 200), but its response couldn\'t be saved to "files/out.json": Mount "files" is read-only.',
      'Anything the POST changed on the service stays changed, so check before sending it again',
    );
  });

  // agent-framework's writeBinary stores the file in the workspace before it
  // writes the copy on disk, and marks a write that got that far inChronicle.
  it('counts a response the workspace stored as saved when only its copy on disk failed, and says what disk lacks', async () => {
    const diskFailed = '"files/out.json" is saved in the workspace, but updating its copy on disk didn\'t complete: EACCES.';
    const { mod, ready } = registeredModule({
      workspace: { writeBinary: async () => ({ success: false, isError: true, error: diskFailed, data: { inChronicle: true } }) },
    });
    await ready;
    const res = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/x', method: 'POST', body: {}, saveAs: 'files/out.json',
    }));
    expect(res.success).toBe(true);
    expect((res.data as any).saved).toMatchObject({ path: 'files/out.json', diskCopyError: diskFailed });
  });

  it("words the identity service's answers by their status: retry a 429 or 5xx, and not another refusal", async () => {
    let answer = new Response(JSON.stringify({ error: 'busy' }), { status: 503 });
    const { mod, ready, seen } = registeredModule({ token: () => answer });
    await ready;
    const busy = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }));
    expectSays(busy.error, 'Nothing was sent to "orrery"', 'couldn\'t give access to "orrery" just now (503: busy)', 'try again shortly');
    answer = new Response(JSON.stringify({ error: 'audience not allowed' }), { status: 403 });
    const refused = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }));
    expectSays(refused.error, 'refused access to "orrery" (403: audience not allowed)', 'Calling again won\'t change that', 'identity--status');
    expect(refused.error).not.toContain('try again');
    expect(seen.orrery).toBe(0);
  });

  it('says a request goes nowhere until the host is registered, and how to register', async () => {
    const { mod, ready, seen } = registeredModule({ register: false });
    await ready;
    const res = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }));
    expectSays(res.error, 'Nothing was sent to "orrery": this host isn\'t registered with the identity service at id.test', 'identity--accept_invite');
    expect(seen.orrery).toBe(0);
  });

  it("accept_invite: a refused name, a busy service, no reply, and a registration this host couldn't record", async () => {
    let enroll = () => new Response(JSON.stringify({ error: 'name taken' }), { status: 403 });
    const { mod, dir } = registeredModule({ register: false, enroll: () => enroll() });
    const join_ = (name = 'A') => mod.handleToolCall(call('accept_invite', { invite: 'inv', name }));
    expectSays((await join_()).error, 'Nothing was registered', 'refused it (403: name taken)', 'call identity--accept_invite again with another');
    enroll = () => new Response(JSON.stringify({ error: 'internal error' }), { status: 500 });
    expectSays((await join_()).error, 'Nothing was registered', 'couldn\'t take it just now (500: internal error)', 'Try again shortly');
    enroll = () => { throw new Error('connection reset'); };
    expectSays(
      (await join_()).error, 'gave no reply (connection reset)', 'whether it registered this host is unknown',
      'again shortly with the same code and name', 'don\'t try another name', 'ask your operator',
    );
    // The record can't be written: a directory where its temporary file goes.
    mkdirSync(join(dir, 'k.json.tmp'));
    enroll = () => new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
    const unrecorded = await join_();
    expectSays(
      unrecorded.error, 'registered this host as "A" (agent:a@guest), but this host couldn\'t record that (EISDIR)',
      'Don\'t call identity--accept_invite again', 'Ask your operator',
    );
    expect(unrecorded.error).not.toContain(dir);
    expect(unrecorded.error).not.toContain('key');
  });

  it('names what a call lacks: the service, the path as given, both of invite and name', async () => {
    const { mod, ready } = registeredModule();
    await ready;
    expectSays((await mod.handleToolCall(call('request', { path: '/x' }))).error, 'needs `service`', 'orrery');
    expectSays((await mod.handleToolCall(call('request', { service: 'orrery', path: 'api/ops' }))).error, 'starting with "/"', 'it was "api/ops"');
    expectSays((await mod.handleToolCall(call('accept_invite', { invite: 'x' }))).error, 'Nothing was registered', 'both `invite`', '`name`');
  });

  it('points a body over the limit at fromFile only where there is a workspace to read one from', async () => {
    const big = { text: 'x'.repeat(REQUEST_BODY_MAX_FOR_TEST + 1) };
    const bare = registeredModule();
    await bare.ready;
    const noWorkspace = await bare.mod.handleToolCall(call('request', { service: 'orrery', path: '/x', method: 'POST', body: big }));
    expectSays(noWorkspace.error, 'Nothing was sent: the body is', 'over the 262144-character limit');
    expect(noWorkspace.error).not.toContain('fromFile');
    const withWs = registeredModule({ workspace: { writeBinary: async () => ({ success: true }) } });
    await withWs.ready;
    expectSays((await withWs.mod.handleToolCall(call('request', { service: 'orrery', path: '/x', method: 'POST', body: big }))).error, '`fromFile`');
  });

  // A key file that can't be read is the host's to fix, and the agent gets
  // the error's code, not a message that can name the host's paths.
  it("says a failure before anything is sent is the host's, without its paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    writeFileSync(join(dir, 'k.pem'), 'not a key at all');
    const mod = new IdentityModule({ keyPath: join(dir, 'k.pem'), home: 'id.test' });
    const res = await mod.handleToolCall(call('status', {}));
    expectSays(res.error, 'identity--status failed (', 'It\'s the host\'s to fix', 'ask your operator');
    expect(res.error).not.toContain(dir);
  });

  it('answers a utility it lacks with its utilities and how to run them', async () => {
    const { mod } = registeredModule({ register: false });
    expectSays(
      (await mod.handleToolCall(call('nope', {}))).error,
      'There\'s no tool "identity--nope", so nothing ran', 'identity--status', 'identity--request', 'identity--accept_invite', 'utils',
    );
  });
});

describe('mcpl-admin access grants', () => {
  it('deploy with `access` requires identity wiring, and stores the NAME not a credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpl-'));
    const mod = new McplAdminModule({ overlayPath: join(dir, 'overlay.json') });
    // stub framework so the deploy reaches the access check
    mod.setFramework({
      listMcplServers: () => [],
      connectMcplServer: async () => {},
      restartMcplServer: async () => {},
      disconnectMcplServer: async () => {},
    } as any);

    // no identity wired → clear bounce
    const refused = await mod.handleToolCall(call('mcpl_deploy', {
      id: 'worlds', url: 'wss://example.test/mcpl', access: 'eidoverse',
    }) as any);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('identity');
  });

  it('surface flags: default keeps four first-class tools; utilities parks them', () => {
    const asTools = new McplAdminModule({});
    expect(asTools.getTools().length).toBe(4);
    expect(asTools.getUtilities().length).toBe(0);

    const asUtils = new McplAdminModule({ surface: 'utilities' });
    expect(asUtils.getTools().length).toBe(0);
    expect(asUtils.getUtilities().map((u) => u.name).sort()).toEqual(
      ['mcpl_deploy', 'mcpl_list', 'mcpl_restart', 'mcpl_unload'],
    );
  });
});

describe('observers surface flag', () => {
  it('same definitions on either surface', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-'));
    const asTools = new ObserversModule({ path: join(dir, 'observers.json') });
    const asUtils = new ObserversModule({ path: join(dir, 'observers.json'), surface: 'utilities' });
    expect(asTools.getTools().map((t) => t.name)).toEqual(asUtils.getUtilities().map((u) => u.name));
    expect(asTools.getUtilities().length).toBe(0);
    expect(asUtils.getTools().length).toBe(0);
  });
});

// An upload reads only what the workspace mount allows. agent-framework's
// readFileFromDisk keeps the mount's link policy and reads only inside it;
// the disk read this used before checked the path's text alone and followed
// any link, so a link in the mount sent a file from outside it to the
// service. These run agent-framework's own WorkspaceModule on a real mount;
// only the store's copy is set by the test.
describe('identity request: fromFile reads only what the mount allows', () => {
  async function mounted(opts: { followSymlinks?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ident-mount-'));
    const mountDir = join(dir, 'files');
    const outside = join(dir, 'outside');
    mkdirSync(mountDir);
    mkdirSync(outside);
    writeFileSync(join(outside, 'host-secret.txt'), 'the host\'s own file');
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const workspace = new WorkspaceModule({
      mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never', ...(opts.followSymlinks ? { followSymlinks: true } : {}) }],
    });
    workspace.initStore(store);
    // The store's copy of a path, as the resident would have written it through the workspace.
    const stored = new Map<string, Buffer>();
    (workspace as unknown as { readBinary: (p: string) => Promise<unknown> }).readBinary = async (p: string) =>
      (stored.has(p) ? { data: stored.get(p)! } : { error: `File not found: ${p}` });
    const bodies: Buffer[] = [];
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { orrery: 'https://orrery.test' },
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u.includes('/services')) return new Response(JSON.stringify({ services: {} }), { status: 200 });
        bodies.push(Buffer.from(init?.body as Uint8Array));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    (mod as any).ctx = { getModule: (n: string) => (n === 'workspace' ? workspace : null) };
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    const upload = (fromFile: string) =>
      mod.handleToolCall(call('request', { service: 'orrery', path: '/api/up', method: 'PUT', fromFile }));
    return { dir, mountDir, outside, stored, bodies, upload };
  }

  it('sends a file in the mount from disk', async () => {
    const { mountDir, bodies, upload } = await mounted();
    writeFileSync(join(mountDir, 'grid.png'), 'disk bytes');
    expect((await upload('files/grid.png')).success).toBe(true);
    expect(bodies.map(String)).toEqual(['disk bytes']);
  });

  it('refuses a link in the mount to a file outside it, sends nothing, and names no host path', async () => {
    const { dir, mountDir, outside, stored, bodies, upload } = await mounted();
    symlinkSync(join(outside, 'host-secret.txt'), join(mountDir, 'link.txt'));
    // Even with a copy in the store, the refusal stands: it isn't sent in the link's place.
    stored.set('files/link.txt', Buffer.from('store bytes'));
    const res = await upload('files/link.txt');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Nothing was sent to "orrery": "files/link.txt" couldn\'t be read from disk');
    expect(res.error).toContain('Symlinks are not allowed: files/link.txt');
    expect(res.error).not.toContain(dir);
    expect(bodies).toEqual([]);
  });

  it('refuses a link leading out of the mount where the mount follows links', async () => {
    const { mountDir, outside, bodies, upload } = await mounted({ followSymlinks: true });
    symlinkSync(join(outside, 'host-secret.txt'), join(mountDir, 'link.txt'));
    const res = await upload('files/link.txt');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Symlink escape detected: files/link.txt');
    expect(bodies).toEqual([]);
  });

  it('refuses a directory, and a file over the upload cap, reading no more of it than the cap', async () => {
    const { mountDir, bodies, upload } = await mounted();
    mkdirSync(join(mountDir, 'album'));
    expect((await upload('files/album')).error).toContain('Path is a directory: files/album');
    // A sparse file one byte over the cap: nothing that large is written to the test's disk.
    writeFileSync(join(mountDir, 'huge.bin'), '');
    truncateSync(join(mountDir, 'huge.bin'), 64 * 1024 * 1024 + 1);
    expect((await upload('files/huge.bin')).error).toContain(`"files/huge.bin" is ${64 * 1024 * 1024 + 1} bytes, over the ${64 * 1024 * 1024}-byte upload limit`);
    expect(bodies).toEqual([]);
  });

  it("sends the workspace's copy of a file disk doesn't have, and when the mount's directory is gone", async () => {
    const { mountDir, stored, bodies, upload } = await mounted();
    stored.set('files/notes.txt', Buffer.from('written through the workspace'));
    expect((await upload('files/notes.txt')).success).toBe(true);
    rmSync(mountDir, { recursive: true, force: true });
    expect((await upload('files/notes.txt')).success).toBe(true);
    expect(bodies.map(String)).toEqual(['written through the workspace', 'written through the workspace']);
  });
});
