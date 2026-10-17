/**
 * What the fleet tools tell an agent when a call can't do what it asked.
 * Where a refusal's facts depend on the host's state, such as which children
 * it has, how a child stopped, or what a child's subscription carries, these
 * pin those facts and the tool the agent can call next.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FleetModule, type FleetModuleConfig } from '../src/modules/fleet-module.js';

const dirs: string[] = [];
const fleets: FleetModule[] = [];
afterEach(async () => {
  await Promise.all(fleets.splice(0).map((fleet) => fleet.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fleet of lifecycle mock children, each told what to do by the options
 *  its launch writes as its recipe. */
function setup(config: FleetModuleConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-error-wording-'));
  dirs.push(dir);
  const fleet = new FleetModule({
    childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'),
    socketWaitTimeoutMs: 10_000, readyTimeoutMs: 10_000, gracefulShutdownMs: 100, sigtermEscalationMs: 100,
    ...config,
  });
  fleets.push(fleet);
  let calls = 0;
  const call = (name: string, input: unknown) =>
    fleet.handleToolCall({ id: `call-${++calls}`, name, input } as Parameters<FleetModule['handleToolCall']>[0]);
  const launch = (name: string, options: object = {}, extra: object = {}) => {
    const recipe = join(dir, `recipe-${++calls}.json`);
    writeFileSync(recipe, JSON.stringify(options));
    return call('launch', { name, recipe, dataDir: join(dir, name), ...extra });
  };
  return { fleet, dir, call, launch };
}

/** Polls until `ready` holds, for state a child's process or socket changes. */
async function until(ready: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A fleet restored from state holding child 'leaf' as ready, whose files
 *  are still in its data directory but whose socket is a regular file, so
 *  the probe fails, and whose pid (the runner's own) is alive, so nothing
 *  shows the files are a stopped child's. It stays recorded as starting,
 *  unattached. `pid` replaces the runner's. */
async function restored({ pid = process.pid } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-error-wording-'));
  dirs.push(dir);
  const dataDir = join(dir, 'leaf');
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'ipc.sock'), 'left over');
  const state = { children: { leaf: { name: 'leaf', recipePath: resolve('mock-recipe'), dataDir,
    socketPath: join(dataDir, 'ipc.sock'), pid, status: 'ready', startedAt: 1, exitedAt: null,
    lastEventAt: null, exitCode: null, exitReason: null, subscription: ['*'], autoRestart: false } } };
  const fleet = new FleetModule({ childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts') });
  fleets.push(fleet);
  await fleet.start({ getState: () => state, setState: () => {} } as unknown as Parameters<FleetModule['start']>[0]);
  return { fleet, dataDir };
}

describe('fleet refusals name what the agent can do', () => {
  test('an unknown child name is answered with the names this host has', async () => {
    const { call, launch } = setup();
    expect((await call('status', { name: 'ghost' })).error).toBe(
      "There's no child named 'ghost', so there is no status to show. This host has no children; fleet--launch starts one.",
    );
    expect((await launch('reviewer')).success).toBe(true);
    expect((await call('kill', { name: 'reviewr' })).error).toBe(
      "There's no child named 'reviewr', so nothing was stopped. This host's one child is 'reviewer'.",
    );
    expect((await launch('writer')).success).toBe(true);
    expect((await launch('critic')).success).toBe(true);
    expect((await call('send', { name: 'editor', content: 'hi' })).error).toBe(
      "There's no child named 'editor', so nothing was sent. This host's children are 'reviewer', 'writer' and 'critic'.",
    );
  });

  test('a name that is not a string is said to be what it is', async () => {
    const { call } = setup();
    expect((await call('peek', { name: 42 })).error).toBe(
      "There are no events to show: it needs a child's name, as a string; it got the number 42. " +
      'This host has no children; fleet--launch starts one.',
    );
  });

  test('a child that has stopped is named as stopped, with how it stopped and how to start it again', async () => {
    const { call, launch } = setup();
    expect((await launch('leaf', { crashBeforeSocket: true })).success).toBe(false);
    expect((await call('send', { name: 'leaf', content: 'hi' })).error).toBe(
      "Nothing was sent: child 'leaf' has crashed (launch failed: the child exited with code 1 before its socket " +
      "appeared (exit: code=1)), so it isn't running. fleet--restart for 'leaf' starts it again.",
    );
    // A signal leaves no exit code; the record names the signal.
    expect((await launch('killed')).success).toBe(true);
    process.kill((await call('status', { name: 'killed' })).data.pid, 'SIGKILL');
    await until(async () => (await call('status', { name: 'killed' })).data.status === 'crashed');
    expect((await call('command', { name: 'killed', command: '/status' })).error).toBe(
      "Nothing was sent: child 'killed' has crashed (SIGKILL), so it isn't running. fleet--restart for 'killed' starts it again.",
    );
  });

  test('a child this host has no connection to is described by its state', async () => {
    const { fleet, call, launch } = setup();
    // Ready, but the child closed the connection without exiting.
    expect((await launch('dropped')).success).toBe(true);
    expect((await call('command', { name: 'dropped', command: '/drop' })).success).toBe(true);
    await until(() => fleet.getChildren().get('dropped')!.socket === null);
    expect((await call('send', { name: 'dropped', content: 'hi' })).error).toBe(
      "Nothing was sent: child 'dropped' is ready, but its connection to this host has closed and its exit hasn't " +
      "been seen yet, so it may be exiting. fleet--status for 'dropped' shows its state; if it still shows ready, " +
      "fleet--restart for 'dropped' stops it and starts it again.",
    );
    // Still starting: a launch that hasn't connected yet.
    const pending = launch('slow', { noSocket: true });
    await until(() => fleet.getChildren().get('slow')?.process != null);
    expect((await call('send', { name: 'slow', content: 'hi' })).error).toBe(
      "Nothing was sent: child 'slow' is still starting, and this host has no connection to it. fleet--status " +
      "for 'slow' shows its state.",
    );
    expect((await call('kill', { name: 'slow' })).success).toBe(true);
    expect((await pending).success).toBe(false);
  });

  test('a restored child this host is not attached to points to fleet--restart', async () => {
    const { fleet } = await restored();
    const result = await fleet.handleToolCall({ id: 'send', name: 'send', input: { name: 'leaf', content: 'hi' } });
    expect(result.error).toBe(
      "Nothing was sent: child 'leaf' is recorded as starting, but this host isn't attached to it (adoption " +
      "unresolved; fleet--restart of it, or fleet--launch with its recipe and dataDir, probes it again). " +
      "fleet--restart for 'leaf' reattaches to it if it's still alive, or starts it again if it isn't.",
    );
  });

  // canRetryAdoption reads a restored record's reason by its prefix, so a
  // later launch, or a later host's start, probes again a record whose
  // adoption was left unresolved.
  test('the reason a restore leaves on an unresolved adoption is one a later launch probes again', async () => {
    const ended = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => ended.once('exit', r));
    const { fleet } = await restored({ pid: ended.pid! });
    const record = fleet.getChildren().get('leaf')!;
    expect(record.status).toBe('crashed');
    expect((fleet as unknown as { canRetryAdoption(r: object): boolean }).canRetryAdoption(record)).toBe(true);
  });

  test('an await on a child that has stopped, before the wait or during it, says so, and which children are idle', async () => {
    const { dir, call, launch } = setup();
    expect((await launch('done', { idle: true })).success).toBe(true);
    await until(async () => (await call('peek', { name: 'done' })).data.events
      .some((e: { phase?: string }) => e.phase === 'idle'));
    expect((await launch('gone', { crashBeforeSocket: true })).success).toBe(false);
    // Ended before the wait began.
    expect((await call('await', { names: ['done', 'gone'] })).error).toBe(
      "Child 'gone' has crashed (launch failed: the child exited with code 1 before its socket appeared " +
      "(exit: code=1)), so there's no idle to wait for. Idle so far: 'done'. fleet--peek for 'gone' shows its " +
      "last events, and fleet--restart for 'gone' starts it again.",
    );
    // Ended during the wait.
    const trigger = join(dir, 'crash-now');
    expect((await launch('busy', { crashOnFile: trigger })).success).toBe(true);
    const waiting = call('await', { names: ['busy'], timeoutMs: 10_000 });
    writeFileSync(trigger, '');
    expect((await waiting).error).toBe(
      "Child 'busy' has crashed (code=1), so there's no idle to wait for. Idle so far: none. fleet--peek for " +
      "'busy' shows its last events, and fleet--restart for 'busy' starts it again.",
    );
    // Gone idle, then crashed: it isn't named idle beside its own stop.
    const idleThenCrash = join(dir, 'crash-idle');
    expect((await launch('idler', { idle: true, crashOnFile: idleThenCrash })).success).toBe(true);
    await until(async () => (await call('peek', { name: 'idler' })).data.events
      .some((e: { phase?: string }) => e.phase === 'idle'));
    writeFileSync(idleThenCrash, '');
    await until(async () => (await call('status', { name: 'idler' })).data.status === 'crashed');
    expect((await call('await', { names: ['idler', 'done'] })).error).toBe(
      "Child 'idler' has crashed (code=1), so there's no idle to wait for. Idle so far: 'done'. fleet--peek for " +
      "'idler' shows its last events, and fleet--restart for 'idler' starts it again.",
    );
  });

  // The exit handler schedules autoRestart's retry, perhaps after the error
  // is written, so the error says one may come and how to stop it.
  test('a failed launch with autoRestart says the child may be started again by itself', async () => {
    const { call, launch } = setup();
    expect((await launch('leaf', { crashBeforeSocket: true }, { autoRestart: true })).error).toStartWith(
      "Child 'leaf' didn't start (launch failed: the child exited with code 1 before its socket appeared) and has " +
      'exited. Nothing is running now, though its autoRestart may start it again by itself; fleet--kill for ' +
      "'leaf' stops that. Once the cause is fixed, call fleet--launch again.",
    );
    expect((await call('kill', { name: 'leaf' })).success).toBe(true);
  });

  // Once its automatic restarts have ended, such as at the flap cap when the
  // exit handler ran first, no retry is coming, so the error promises none.
  test('a failed launch whose automatic restarts have ended promises no retry', async () => {
    const { fleet } = setup();
    const ended = spawn(process.execPath, ['-e', 'process.exit(1)']);
    await new Promise((r) => ended.once('exit', r));
    const failLaunch = (fleet as unknown as {
      failLaunch(child: object, reason: string): Promise<{ error: string }>;
    }).failLaunch.bind(fleet);
    const child = (autoRestartStopped?: string) => ({
      name: 'leaf', process: ended, pid: ended.pid, status: 'crashed', exitedAt: Date.now(), exitCode: 1,
      exitReason: 'code=1', autoRestart: true, killRequested: false, autoRestartStopped,
    });
    expect((await failLaunch(child('3 restarts within 60s; fleet--restart or fleet--launch starts it again'),
      'launch failed: test')).error).toBe(
      "Child 'leaf' didn't start (launch failed: test) and has exited. Nothing is running, so call fleet--launch " +
      'again once the cause is fixed.',
    );
    expect((await failLaunch(child(), 'launch failed: test')).error).toContain(
      'its autoRestart may start it again by itself',
    );
  });

  test('a call without an argument it needs says what it was given', async () => {
    const { fleet, call } = setup();
    const unnamed = await call('launch', { recipe: 'recipes/x.json' });
    expect(unnamed.error).toStartWith('Nothing was launched: fleet--launch needs "name"');
    expect(unnamed.error).toEndWith('; none was given.');
    expect((await call('launch', { name: 'leaf', recipe: 42 })).error).toEndWith('; it got the number 42.');
    expect((await call('relay', { from: 'leaf' })).error).toEndWith(
      'for "from", it got the string "leaf", and for "to", none was given.',
    );
    expect((await call('launch', { name: '', recipe: 'r' })).error).toEndWith('; it got an empty string.');
    expect((await call('launch', { name: null, recipe: 'r' })).error).toEndWith('; it got null.');
    expect((await call('launch', { name: ['a'], recipe: 'r' })).error).toEndWith('; it got a list.');
    expect((await call('launch', { name: { a: 1 }, recipe: 'r' })).error).toEndWith('; it got an object.');
    // Optional arguments of another type, which threw or, for a string
    // subscription, were split into characters.
    expect((await call('launch', { name: 'leaf', recipe: 'r', dataDir: 5 })).error).toBe(
      'Nothing was launched: fleet--launch\'s "dataDir", when given, is the child\'s data directory as a string, ' +
      'absolute or relative to this host\'s working directory, such as "data/reviewer"; it got the number 5.',
    );
    expect((await call('launch', { name: 'leaf', recipe: 'r', subscription: 'inference:speech' })).error).toBe(
      'Nothing was launched: fleet--launch\'s "subscription", when given, is a list of event names, such as ' +
      '["lifecycle", "inference:speech"]; it got the string "inference:speech".',
    );
    expect((await call('launch', { name: 'leaf', recipe: 'r', subscription: ['lifecycle', 7] })).error).toEndWith(
      "; it got a list whose entry 2 isn't a string: the number 7.",
    );
    expect(fleet.getChildren().size).toBe(0);
  });

  test('a call to a fleet tool that does not exist lists the fleet tools', async () => {
    const { call } = setup();
    const result = await call('frobnicate', {});
    expect(result.error).toStartWith("There's no tool \"fleet--frobnicate\", so nothing ran. The fleet tools are fleet--launch, ");
    expect(result.error).toContain('fleet--relay');
  });

  test('a recipe outside the allowlist names the allowed recipes, or says there are none', async () => {
    const listed = setup({ allowedRecipes: ['/recipes/miner.json', 'recipes/*'] });
    expect((await listed.launch('leaf')).error).toContain(
      'The allowed recipes are /recipes/miner.json, any recipe whose path starts with "recipes/". Launch one of ' +
      "those, or ask the user to add this one to modules.fleet.allowedRecipes in this host's recipe.",
    );
    const none = setup({ allowedRecipes: [] });
    expect((await none.launch('leaf')).error).toEndWith(
      "It allows none, so ask the user to add this one to modules.fleet.allowedRecipes in this host's recipe.",
    );
  });

  // The floor the host adds to every subscription leaves inference:speech
  // out, so a child launched without it never reports a reply to relay.
  test('a relay from a child whose subscription leaves out inference:speech says so', async () => {
    const { call, launch } = setup();
    expect((await launch('src', {}, { subscription: ['lifecycle'] })).success).toBe(true);
    expect((await launch('dst')).success).toBe(true);
    const relay = await call('relay', { from: 'src', to: 'dst' });
    expect(relay.error).toStartWith(
      "Nothing was relayed: 'src' has no finished reply on record, since its subscription (lifecycle) leaves out " +
      'inference:speech',
    );
    expect(relay.error).toEndWith(
      "fleet--restart keeps that subscription, so fleet--kill 'src', then fleet--launch it again with the recipe, " +
      'dataDir and autoRestart that fleet--status shows for it, and a subscription that includes inference:speech.',
    );
  });

  // env reaches a child only from this host's recipe, and fleet--launch
  // can't pass it, so a kill and relaunch would lose it.
  test("a relay from a child started with the recipe's env points to the recipe, not to a relaunch", async () => {
    const { fleet, dir, call, launch } = setup();
    const recipe = join(dir, 'env-recipe.json');
    writeFileSync(recipe, '{}');
    const started = await (fleet as unknown as {
      handleLaunch(input: object, opts: { viaAutoStart: boolean }): Promise<{ success: boolean }>;
    }).handleLaunch({ name: 'src', recipe, dataDir: join(dir, 'src'), env: { FLEET_TEST_SENTINEL: 'x' },
      subscription: ['lifecycle'] }, { viaAutoStart: true });
    expect(started.success).toBe(true);
    expect((await launch('dst')).success).toBe(true);
    expect((await call('relay', { from: 'src', to: 'dst' })).error).toEndWith(
      "fleet--restart keeps that subscription, and fleet--launch can't pass the env 'src' was started with, so a " +
      "relaunch would lose it. Ask the user to add inference:speech to its subscription in this host's recipe; " +
      "this host starts it with that subscription at its next start, if 'src' isn't running then.",
    );
  });

  // For a child whose subscription carries its replies, a reply can come only
  // from one this host can reach. For one it can, the error names both steps,
  // since nothing marks the start of a child's work, so an idle event can be
  // older than the work a send gave it.
  test('a relay from a child with no finished reply says what would bring one', async () => {
    const { fleet, call, launch } = setup();
    const steps = (name: string) => `Nothing was relayed: '${name}' hasn't finished a reply since this host began ` +
      'tracking it. A reply counts once one of its inference rounds ends without tool calls, and fleet--relay passes ' +
      `it on then; if '${name}' has nothing to answer, fleet--send gives it something.`;
    expect((await launch('dst')).success).toBe(true);
    expect((await launch('busy')).success).toBe(true);
    expect((await call('relay', { from: 'busy', to: 'dst' })).error).toBe(steps('busy'));
    expect((await launch('idle', { idle: true })).success).toBe(true);
    await until(async () => (await call('peek', { name: 'idle' })).data.events
      .some((e: { phase?: string }) => e.phase === 'idle'));
    expect((await call('relay', { from: 'idle', to: 'dst' })).error).toBe(steps('idle'));
    // A ready child whose connection has closed can't send one.
    expect((await launch('dropped')).success).toBe(true);
    expect((await call('command', { name: 'dropped', command: '/drop' })).success).toBe(true);
    await until(() => fleet.getChildren().get('dropped')!.socket === null);
    expect((await call('relay', { from: 'dropped', to: 'dst' })).error).toBe(
      "Nothing was relayed: 'dropped' hasn't finished a reply since this host began tracking it, and it is ready, " +
      "but its connection to this host has closed and its exit hasn't been seen yet, so it may be exiting. " +
      "fleet--status for 'dropped' shows its state; if it still shows ready, fleet--restart for 'dropped' stops it " +
      'and starts it again.',
    );
    // One that has exited gives none.
    expect((await call('kill', { name: 'busy' })).success).toBe(true);
    expect((await call('relay', { from: 'busy', to: 'dst' })).error).toBe(
      "Nothing was relayed: 'busy' hasn't finished a reply since this host began tracking it, and it has exited " +
      "(clean), so it isn't running. fleet--restart for 'busy' starts it again.",
    );
  });

  // Such as one under a directory that doesn't exist at the root, for a host
  // that isn't root: the file system's own message reached the agent.
  test('a data directory the host cannot create is refused with its error code', async () => {
    const { fleet, dir, call } = setup();
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, '{}');
    const dataDir = join(dir, 'no-access', 'leaf');
    const mkdir = spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw Object.assign(new Error(`EACCES: permission denied, mkdir '${join(dir, 'no-access')}'`), { code: 'EACCES' });
    });
    try {
      expect((await call('launch', { name: 'leaf', recipe, dataDir })).error).toBe(
        `Nothing was launched: this host couldn't create the data directory ${dataDir} (EACCES). Give ` +
        'fleet--launch another dataDir, or ask whoever runs this host to check that path.',
      );
      // Refused before the record is made, so no starting record blocks the name.
      expect(fleet.getChildren().has('leaf')).toBe(false);
    } finally {
      mkdir.mockRestore();
    }
  });

  // A record of the name in that directory is one a later launch can
  // reattach to or clear up after, so the refusal points to it.
  test('files left by an earlier run of a tracked child point to its record', async () => {
    const { fleet, dataDir } = await restored();
    const result = await fleet.handleToolCall({ id: 'tracked', name: 'launch', input: { name: 'leaf', recipe: 'mock-recipe', dataDir } });
    expect(result.error).toBe(
      `Nothing was launched: ${join(dataDir, 'ipc.sock')} is still there from an earlier run of 'leaf', and this host ` +
      "couldn't reattach to a child there or confirm that those files are a stopped child's. fleet--status for 'leaf' " +
      'shows its record. Calling fleet--launch again with the recipe it names retries: it reattaches once that child ' +
      "has finished starting, and clears the files once this host can confirm they're a stopped child's. If it keeps " +
      `refusing, ask whoever runs this host to check ${join(dataDir, 'ipc.sock')} and ${join(dataDir, 'headless.pid')}, ` +
      'or give fleet--launch another dataDir.',
    );
  });
});
