import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall } from '@animalabs/agent-framework';
import { ObserversModule } from '../src/modules/observers-module.js';
import { loadObserversFile } from '../src/modules/web-ui-observers.js';

// A canonical key: 43 base64url characters whose last one carries no stray bits.
const key = (c: string) => `ed25519:${c.repeat(42)}A`;
/** The same 32 bytes in standard base64, padded. */
const stdSpelling = (k: string) => `ed25519:${Buffer.from(k.slice(8), 'base64url').toString('base64')}`;
const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `t-${name}`, name, input });
const stored = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as { observers: Array<Record<string, unknown>> } & Record<string, unknown>;
const keys = (path: string) => stored(path).observers.map((g) => g.key);
const labels = (data: unknown) => (data as { observers: Array<{ label: string }> }).observers.map((g) => g.label);

const BASELINE = { key: key('A'), label: 'baseline', scopes: ['health'], protected: true };
const PHONE = { key: key('B'), label: 'antra-phone', scopes: ['messages', 'tool-calls'] };
// A file an operator set up and then broke by hand: a protected baseline
// grant, and a second grant with a scope that doesn't exist.
const BAD_SCOPE = JSON.stringify({ observers: [BASELINE, PHONE] }, null, 2);
const TRUNCATED = BAD_SCOPE.slice(0, BAD_SCOPE.length - 10);
const GOOD = JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }] }, null, 2);
const SAYS = 'grant 2 ("antra-phone") names a scope that doesn\'t exist: "tool-calls"';

describe('observers tools and the grants file', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'observers-'));
    path = join(dir, 'observers.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('truncated JSON: grant, revoke and get refuse, and the file is left as it was', async () => {
    writeFileSync(path, TRUNCATED);
    const m = new ObserversModule({ path });
    const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
    expect(grant.error).toStartWith('Nothing was granted:');
    expect(grant.error).toContain(`${path}, isn't valid JSON`);
    expect(grant.error).toContain('These tools don\'t write over a file they can\'t read as grants');
    expect(grant.error).toContain('whoever runs this host');
    const revoke = await m.handleToolCall(call('revoke', { label: 'baseline' }));
    expect(revoke.error).toStartWith('Nothing was revoked:');
    expect(revoke.error).toContain(path);
    expect(revoke.error).toContain('then revoke again');
    const get = await m.handleToolCall(call('get', {}));
    expect(get.error).toStartWith('The grants can\'t be listed:');
    expect(get.error).toContain('Until it parses');
    expect(get.error).toContain('whoever runs this host');
    expect(readFileSync(path, 'utf-8')).toBe(TRUNCATED);
  });

  test('a bad grant: get lists the usable ones and names it, and a grant keeps it as found', async () => {
    writeFileSync(path, BAD_SCOPE);
    const m = new ObserversModule({ path });
    const get = await m.handleToolCall(call('get', {}));
    expect(labels(get.data)).toEqual(['baseline']);
    expect((get.data as { notUsed: string[] }).notUsed).toEqual([`${SAYS} (the scopes are health, ops, messages, tools, thinking, debug)`]);

    const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
    expect(grant.success).toBe(true);
    expect(labels(grant.data)).toEqual(['baseline', 'new']);
    expect((grant.data as { notUsed: string[] }).notUsed[0]).toStartWith(SAYS);
    expect(stored(path).observers).toEqual([BASELINE, PHONE, { key: key('C'), label: 'new', scopes: ['health'], expires: null }]);
  });

  test('a bad protected baseline doesn\'t stop the agent withdrawing its own grant', async () => {
    const baseline = { ...BASELINE, expires: 'next week' };
    writeFileSync(path, JSON.stringify({ observers: [baseline, { ...PHONE, scopes: ['messages'] }] }));
    const m = new ObserversModule({ path });
    const revoke = await m.handleToolCall(call('revoke', { label: 'antra-phone' }));
    expect(revoke.success).toBe(true);
    expect(stored(path).observers).toEqual([baseline]);
    const get = await m.handleToolCall(call('get', {}));
    expect(labels(get.data)).toEqual([]);
    expect((get.data as { notUsed: string[] }).notUsed).toEqual(['grant 1 ("baseline") has an expiry that isn\'t a date: "next week"']);
  });

  for (const [what, change, after] of [
    ['revoking the grant that\'s wrong', call('revoke', { label: 'antra-phone' }), [key('A')]],
    ['granting its key again with good values', call('grant', { key: key('B'), label: 'antra-phone', scopes: ['messages'] }), [key('A'), key('B')]],
  ] as const) {
    test(`${what} leaves a file whose every grant is used, and the protected grant stays`, async () => {
      writeFileSync(path, BAD_SCOPE);
      const res = await new ObserversModule({ path }).handleToolCall(change);
      expect(res.success).toBe(true);
      expect((res.data as { notUsed?: string[] }).notUsed).toBeUndefined();
      expect(keys(path)).toEqual([...after]);
      expect(stored(path).observers[0]).toEqual(BASELINE);
    });
  }

  test('a repeated key: a grant replaces every entry for it, and a revoke by key or label takes them all', async () => {
    const narrow = { key: key('B'), label: 'phone (narrow)', scopes: ['health'] };
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }, narrow] }));
    const m = new ObserversModule({ path });
    const get = await m.handleToolCall(call('get', {}));
    expect((get.data as { notUsed: string[] }).notUsed).toEqual(['grant 3 ("phone (narrow)") repeats the key of grant 2, so it isn\'t used']);
    expect((await m.handleToolCall(call('grant', { key: key('B'), label: 'phone', scopes: ['health'] }))).success).toBe(true);
    expect(stored(path).observers.map((g) => g.label)).toEqual(['baseline', 'phone']);

    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }, narrow] }));
    expect((await m.handleToolCall(call('revoke', { key: key('B') }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A')]);

    // By label too: revoking the entry in use takes the repeat with it, so
    // the repeat isn't used in its place.
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }, narrow] }));
    const byLabel = await m.handleToolCall(call('revoke', { label: 'antra-phone' }));
    expect(byLabel.success).toBe(true);
    expect((byLabel.data as { message: string }).message).toStartWith('Revoked: antra-phone, phone (narrow).');
    expect(keys(path)).toEqual([key('A')]);

    // A label whose key also holds a protected grant is refused.
    const shadow = { key: key('A'), label: 'baseline copy', scopes: ['health'] };
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, shadow] }));
    const overBaseline = await m.handleToolCall(call('revoke', { label: 'baseline copy' }));
    expect(overBaseline.error).toContain('that key also holds a protected grant');
    expect(stored(path).observers).toEqual([BASELINE, shadow]);

    // So is one by key, or a grant, when the protected entry comes second.
    writeFileSync(path, JSON.stringify({ observers: [shadow, BASELINE] }));
    expect((await m.handleToolCall(call('revoke', { key: key('A') }))).error).toContain('that key also holds a protected grant');
    expect((await m.handleToolCall(call('grant', { key: key('A'), label: 'mine', scopes: ['health'] }))).error).toContain('protected');
    expect(stored(path).observers).toEqual([shadow, BASELINE]);

    // A label that names two entries is refused.
    const twin = { key: key('D'), label: 'antra-phone', scopes: ['health'] };
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }, twin] }));
    expect((await m.handleToolCall(call('revoke', { label: 'antra-phone' }))).error).toContain('label matches 2 grants');
    expect(keys(path)).toEqual([key('A'), key('B'), key('D')]);
    const overProtected = await m.handleToolCall(call('grant', { key: key('A'), label: 'mine now', scopes: ['debug'] }));
    expect(overProtected.isError).toBe(true);
  });

  test('a document that isn\'t a grants file is refused, and an object with no list takes one', async () => {
    for (const body of ['null', '[]', '42', '{"observers": {}}']) {
      writeFileSync(path, body);
      const grant = await new ObserversModule({ path }).handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
      expect(grant.error).toStartWith('Nothing was granted:');
      expect(readFileSync(path, 'utf-8')).toBe(body);
    }
    writeFileSync(path, '{"note": "kept"}');
    expect((await new ObserversModule({ path }).handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))).success).toBe(true);
    expect(stored(path)).toEqual({ note: 'kept', observers: [{ key: key('C'), label: 'new', scopes: ['health'], expires: null }] });
  });

  test('a directory at the path is refused by all three tools, and left as it is', async () => {
    mkdirSync(path);
    const m = new ObserversModule({ path });
    const answers = [
      ['Nothing was granted:', await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))],
      ['Nothing was revoked:', await m.handleToolCall(call('revoke', { label: 'baseline' }))],
      ['The grants can\'t be listed:', await m.handleToolCall(call('get', {}))],
    ] as const;
    for (const [opening, answer] of answers) {
      expect(answer.isError).toBe(true);
      expect(answer.error).toStartWith(opening);
      expect(answer.error).toContain(`${path}, can't be read`);
    }
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(readdirSync(path)).toEqual([]);
  });

  test('through a link to a readable file, a grant writes that file and the link stays a link', async () => {
    mkdirSync(join(dir, 'real'));
    const real = join(dir, 'real', 'observers.json');
    writeFileSync(real, GOOD);
    symlinkSync(real, path);
    expect((await new ObserversModule({ path }).handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))).success).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(keys(real)).toEqual([key('A'), key('B'), key('C')]);
  });

  test('a link whose file is gone is refused, and the link is left in place', async () => {
    symlinkSync(join(dir, 'gone', 'observers.json'), path);
    const m = new ObserversModule({ path });
    const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
    expect(grant.error).toStartWith('Nothing was granted:');
    expect(grant.error).toContain('is a link to a file that can\'t be read');
    expect((await m.handleToolCall(call('get', {}))).isError).toBe(true);
    expect((await m.handleToolCall(call('revoke', { key: key('B') }))).isError).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  test('every bad entry is named, and the good ones still listed', async () => {
    writeFileSync(path, JSON.stringify({ observers: [
      { key: 'rsa:x', label: 'one', scopes: ['health'] },
      { key: key('B'), label: 'two', scopes: 'health', expires: 'soon' },
      7,
      { key: key('D'), label: 'four', scopes: ['health'], expires: 'next week' },
      { key: key('E'), label: 'five', scopes: ['health', 'tool-calls', 'logs'] },
      { key: key('F'), label: 'six', scopes: ['health'] },
      null,
      { key: key('G'), label: 'eight', scopes: [] },
      { key: key('H'), label: 'nine', scopes: ['health'], expires: { toString: 1, valueOf: 1 } },
      { key: 'ed25519:' + key('I').slice(9), label: 'ten', scopes: ['health'] },
    ] }));
    const m = new ObserversModule({ path });
    const get = await m.handleToolCall(call('get', {}));
    expect(labels(get.data)).toEqual(['six']);
    const notUsed = (get.data as { notUsed: string[] }).notUsed;
    expect(notUsed).toContain('grant 1 ("one") has no "ed25519:" key');
    expect(notUsed).toContain('grant 2 ("two") has an expiry that isn\'t a date: "soon"');
    expect(notUsed).toContain('grant 2 ("two") has no list of scopes');
    expect(notUsed).toContain('grant 3 isn\'t an object');
    expect(notUsed).toContain('grant 4 ("four") has an expiry that isn\'t a date: "next week"');
    expect(notUsed).toContain('grant 5 ("five") names scopes that don\'t exist: "tool-calls", "logs" (the scopes are health, ops, messages, tools, thinking, debug)');
    expect(notUsed).toContain('grant 7 isn\'t an object');
    expect(notUsed).toContain('grant 8 ("eight") has no scopes');
    expect(notUsed).toContain('grant 9 ("nine") has an expiry that isn\'t a date: {"toString":1,"valueOf":1}');
    expect(notUsed).toContain('grant 10 ("ten") has a key that doesn\'t decode to 32 bytes');
    // A grant and a revoke read past the null entry and keep it as found.
    expect((await m.handleToolCall(call('grant', { key: key('J'), label: 'eleven', scopes: ['health'] }))).success).toBe(true);
    expect((await m.handleToolCall(call('revoke', { label: 'eleven' }))).success).toBe(true);
    expect(stored(path).observers[6]).toBeNull();
    expect(stored(path).observers).toHaveLength(10);
  });

  test('one key spelled two ways is one key: the second is a repeat, and a revoke of either takes both', async () => {
    const phone = { key: key('B'), label: 'phone', scopes: ['health'] };
    const phoneStd = { key: stdSpelling(key('B')), label: 'phone-std', scopes: ['health', 'messages'] };
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, phone, phoneStd] }));
    const m = new ObserversModule({ path });
    const get = await m.handleToolCall(call('get', {}));
    expect(labels(get.data)).toEqual(['baseline', 'phone']);
    expect((get.data as { notUsed: string[] }).notUsed).toEqual(['grant 3 ("phone-std") repeats the key of grant 2, so it isn\'t used']);
    expect((await m.handleToolCall(call('revoke', { label: 'phone' }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A')]);

    writeFileSync(path, JSON.stringify({ observers: [BASELINE, phone, phoneStd] }));
    expect((await m.handleToolCall(call('revoke', { key: stdSpelling(key('B')) }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A')]);

    // A grant in the other spelling is written in canonical form, in place of both.
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, phone, phoneStd] }));
    expect((await m.handleToolCall(call('grant', { key: stdSpelling(key('B')), label: 'phone', scopes: ['tools'] }))).success).toBe(true);
    expect(stored(path).observers).toEqual([BASELINE, { key: key('B'), label: 'phone', scopes: ['tools'], expires: null }]);
  });

  test('a number too large for JSON is written back as text, so the grant it broke stays unused', async () => {
    // 1e309 parses as Infinity, which JSON.stringify would write as null: no expiry at all.
    writeFileSync(path, `{"observers": [${JSON.stringify(BASELINE)}, {"key": "${key('B')}", "label": "forever?", "scopes": ["health"], "expires": 1e309}]}`);
    const m = new ObserversModule({ path });
    expect((await m.handleToolCall(call('get', {}))).data).toMatchObject({ notUsed: ['grant 2 ("forever?") has an expiry that isn\'t a date: Infinity'] });
    expect((await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))).success).toBe(true);
    expect(stored(path).observers[1]!.expires).toBe('Infinity');
    expect(loadObserversFile(path)?.observers.map((g) => g.label)).toEqual(['baseline', 'new']);
  });

  test('a revoke by label takes every entry spelled with its key, when the key doesn\'t decode', async () => {
    const short = 'ed25519:short';
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { key: short, label: 'a', scopes: ['health'] }, { key: short, label: 'b', scopes: ['health'] }] }));
    const res = await new ObserversModule({ path }).handleToolCall(call('revoke', { label: 'a' }));
    expect((res.data as { message: string }).message).toStartWith('Revoked: a, b.');
    expect(keys(path)).toEqual([key('A')]);
  });

  test('a grant refuses a key that doesn\'t decode to 32 bytes', async () => {
    writeFileSync(path, GOOD);
    const dropped = key('C').slice(0, -1); // one character short
    const grant = await new ObserversModule({ path }).handleToolCall(call('grant', { key: dropped, label: 'short', scopes: ['health'] }));
    expect(grant.error).toContain('decodes to 32 bytes');
    expect(readFileSync(path, 'utf-8')).toBe(GOOD);
  });

  test('with a readable file, grant and revoke keep every other grant, and leave the protected one alone', async () => {
    writeFileSync(path, GOOD);
    const m = new ObserversModule({ path });
    expect((await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A'), key('B'), key('C')]);
    const overProtected = await m.handleToolCall(call('grant', { key: key('A'), label: 'mine now', scopes: ['debug'] }));
    expect(overProtected.isError).toBe(true);
    const revokeProtected = await m.handleToolCall(call('revoke', { label: 'baseline' }));
    expect(revokeProtected.isError).toBe(true);
    expect(stored(path).observers[0]).toEqual(BASELINE);
    expect((await m.handleToolCall(call('revoke', { key: key('B') }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A'), key('C')]);
  });

  test('control: with no file yet, a grant creates it, and get lists it', async () => {
    const m = new ObserversModule({ path });
    const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
    expect(grant.success).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(labels((await m.handleToolCall(call('get', {}))).data)).toEqual(['new']);
  });

  test('the registry\'s reading: a good file loads whole, a bad grant is left out, and a missing file is null', () => {
    expect(loadObserversFile(path)).toBeNull();
    writeFileSync(path, BAD_SCOPE);
    expect(loadObserversFile(path)).toEqual({ observers: [BASELINE] } as never);
    writeFileSync(path, JSON.stringify({ observers: [{ key: key('A'), label: 'ok', scopes: ['health'], extra: 1 }] }));
    expect(loadObserversFile(path)).toEqual({ observers: [{ key: key('A'), label: 'ok', scopes: ['health'], extra: 1 }] } as never);
  });
});
