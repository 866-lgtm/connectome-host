// A headless host whose one agent takes a turn that arms a self-restart,
// then goes idle. Mode `self-restart`: the host should exit 75 on its own.
// Mode `sigterm-first`: the test sends SIGTERM while the turn is still
// running, so the host exits 0 and the request records that shutdown.
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';
import { selfRestart } from '../src/self-restart.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
if (mode !== 'self-restart' && mode !== 'sigterm-first') throw new Error('Unknown self-restart fixture mode');

const agent = { name: 'fixture', state: { status: 'idle' as string } };
let trace: ((event: unknown) => void) | undefined;

setTimeout(() => {
  // The turn: inference starts, the tool arms the restart, and (in the
  // self-restart mode) the turn ends 300 ms later.
  agent.state.status = 'inferring';
  trace?.({ type: 'inference:started', agentName: 'fixture' });
  selfRestart.arm(process.env.DATA_DIR!, { requestedAt: new Date().toISOString(), reason: 'fixture restart' });
  writeFileSync(join(process.env.DATA_DIR!, 'armed'), 'yes');
  if (mode === 'self-restart') setTimeout(() => { agent.state.status = 'idle'; }, 300);
}, 200);

await runHeadless({
  recipe: { name: 'Self-restart test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [agent],
    onTrace: (cb: (event: unknown) => void) => { trace = cb; return () => {}; },
    async stop() {
      writeFileSync(join(process.env.DATA_DIR!, 'stopped'), agent.state.status);
    },
  },
} as unknown as AppContext);
