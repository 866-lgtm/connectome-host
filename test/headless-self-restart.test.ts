import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELF_RESTART_EXIT_CODE, SELF_RESTART_FILE } from '../src/self-restart.js';

async function runFixture(mode: 'self-restart' | 'sigterm-first') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-self-restart-')));
  const child = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-self-restart-child.ts'), mode], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (c) => { output += c; });
  child.stderr!.on('data', (c) => { output += c; });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (mode === 'sigterm-first') {
    const deadline = performance.now() + 5000;
    while (!existsSync(join(dir, 'armed'))) {
      if (child.exitCode !== null) throw new Error(`Child exited early: ${output}`);
      if (performance.now() >= deadline) throw new Error(`Never armed: ${output}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const result = await closed;
  clearTimeout(timer);
  return { dir, result, output };
}

test('an armed self-restart exits 75 once the turn has ended, and records the exit', async () => {
  const { dir, result, output } = await runFixture('self-restart');
  expect(result.signal).toBeNull();
  expect(result.code).toBe(SELF_RESTART_EXIT_CODE);
  // The stop came after the turn ended, not during it.
  expect(readFileSync(join(dir, 'stopped'), 'utf-8')).toBe('idle');
  const request = JSON.parse(readFileSync(join(dir, SELF_RESTART_FILE), 'utf-8'));
  expect(request).toMatchObject({ reason: 'fixture restart', exitReason: 'self-restart', exitCode: SELF_RESTART_EXIT_CODE });
  expect(typeof request.exitedAt).toBe('string');
  expect(readFileSync(join(dir, 'headless.log'), 'utf-8')).toContain('shutdown: self-restart');
  expect(existsSync(join(dir, 'ipc.sock'))).toBe(false);
  void output;
}, 15_000);

test('another shutdown that comes first exits as it would, and the request records it', async () => {
  const { dir, result } = await runFixture('sigterm-first');
  expect(result.code).toBe(0);
  const request = JSON.parse(readFileSync(join(dir, SELF_RESTART_FILE), 'utf-8'));
  expect(request).toMatchObject({ exitReason: 'SIGTERM', exitCode: 0 });
}, 15_000);
