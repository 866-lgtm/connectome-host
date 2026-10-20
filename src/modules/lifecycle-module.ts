/**
 * LifecycleModule — the agent restarts its own host (`lifecycle--restart`).
 *
 * Opt-in per recipe (`modules.selfRestart`). The tool arms a restart; the
 * host exits once the turn that asked has ended and every agent is idle, with
 * exit code 75, and its supervisor starts it again (src/self-restart.ts).
 * Only headless mode has that exit path, so elsewhere the tool refuses: an
 * exit there would stop the agent for good.
 *
 * After the restart, this module's start() tells the agent, in one context
 * line, when it asked, why, when the host stopped and when it came back.
 * It never wakes the agent.
 */

import { readFileSync } from 'node:fs';
import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import { formatZonedDateTime, resolveTimeZone } from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';
import {
  SELF_RESTART_EXIT_CODE,
  selfRestart as processSelfRestart,
  type SelfRestartRecord,
  type SelfRestartState,
} from '../self-restart.js';

export const DEFAULT_SELF_RESTART_COOLDOWN_MINUTES = 10;

export interface LifecycleModuleConfig {
  /** Where `self-restart.json` / `self-restart.last.json` live (the host's DATA_DIR). */
  dataDir: string;
  /** Minimum time between completed self-restarts. Default 10. */
  cooldownMinutes?: number;
  timeZone?: string;
  /** For tests; defaults to the process's state. */
  state?: SelfRestartState;
  /** For tests. */
  now?: () => Date;
  /** For tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** For tests; defaults to the host package's version. */
  hostVersion?: string;
}

function readHostVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** What runs this host, as far as its environment says. */
export function describeSupervisor(env: Record<string, string | undefined>): string {
  const xpc = env.XPC_SERVICE_NAME;
  if (xpc && xpc !== '0' && !xpc.startsWith('application.')) return `launchd job ${xpc}`;
  if (env.INVOCATION_ID) return 'a systemd unit';
  return 'a supervisor this host cannot name (a fleet parent, or something else)';
}

const TOOL_DESCRIPTION =
  'Restart your own host process. Use it to pick up something that only takes effect at start: ' +
  'an edited recipe or config, rebuilt host code, or to recover from a state you cannot get out of otherwise. ' +
  'For one MCPL server, mcpl_restart (if you have it) is the lighter option and keeps you running. ' +
  'The restart does not interrupt you: it happens once this turn has ended and every agent is idle. ' +
  'The host then exits and its supervisor starts it again, usually within seconds; messages that arrive ' +
  'while it is down are handled by whatever catch-up each channel does on reconnect. ' +
  'Your memory and workspace persist; the first turn after the restart rewrites your whole prompt cache once. ' +
  'After the restart you get one line saying when you asked, why, and when you came back. ' +
  '`cancel: true` disarms a pending restart. There is a cooldown between restarts.';

export class LifecycleModule implements Module {
  readonly name = 'lifecycle';

  private ctx: ModuleContext | null = null;
  private readonly dataDir: string;
  private readonly cooldownMs: number;
  private readonly timeZone: string;
  private readonly state: SelfRestartState;
  private readonly now: () => Date;
  private readonly env: Record<string, string | undefined>;
  private readonly hostVersion: string | undefined;

  constructor(config: LifecycleModuleConfig) {
    this.dataDir = config.dataDir;
    this.cooldownMs = (config.cooldownMinutes ?? DEFAULT_SELF_RESTART_COOLDOWN_MINUTES) * 60_000;
    this.timeZone = resolveTimeZone(config.timeZone);
    this.state = config.state ?? processSelfRestart;
    this.now = config.now ?? (() => new Date());
    this.env = config.env ?? process.env;
    this.hostVersion = 'hostVersion' in config ? config.hostVersion : readHostVersion();
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const record = this.state.takeCompleted(this.dataDir, this.now());
    if (record) ctx.addMessage('user', [{ type: 'text', text: this.backNote(record) }]);
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'restart',
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Why you are restarting, in a sentence. It is shown back to you after the restart and kept in the host\'s data dir.',
            },
            cancel: {
              type: 'boolean',
              description: 'true disarms a pending restart instead of requesting one.',
            },
          },
          required: ['reason'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name !== 'restart') return unknownToolResult(this, call.name);
    const input = (call.input ?? {}) as { reason?: unknown; cancel?: unknown };
    if (input.cancel !== undefined && typeof input.cancel !== 'boolean') {
      return { success: false, error: '`cancel` must be true or false.', isError: true };
    }

    if (input.cancel === true) {
      const pending = this.state.armedRequest();
      if (!this.state.cancel()) {
        return { success: true, data: 'No restart was pending, so there was nothing to cancel.' };
      }
      return {
        success: true,
        data: `Cancelled the restart you asked for at ${this.when(pending!.requestedAt)}. The host keeps running.`,
      };
    }

    if (typeof input.reason !== 'string' || input.reason.trim() === '') {
      return { success: false, error: '`reason` is required: say in a sentence why you are restarting.', isError: true };
    }
    const reason = input.reason.trim();

    if (!this.state.isHeadless()) {
      return {
        success: false,
        isError: true,
        error:
          'Nothing was armed: this host is not running in headless mode, so nothing would start it again, ' +
          'and an exit would stop you until someone starts you by hand. Ask an operator to restart you.',
      };
    }

    const pending = this.state.armedRequest();
    if (pending) {
      return {
        success: true,
        data:
          `A restart is already pending, asked for at ${this.when(pending.requestedAt)} ` +
          `(reason: ${pending.reason}). It happens once this turn ends and every agent is idle. ` +
          '`cancel: true` disarms it.',
      };
    }

    const now = this.now();
    const last = this.state.lastCompleted(this.dataDir);
    if (last && this.cooldownMs > 0) {
      const back = Date.parse(last.backAt);
      if (Number.isFinite(back) && now.getTime() - back < this.cooldownMs) {
        const next = new Date(back + this.cooldownMs);
        return {
          success: false,
          isError: true,
          error:
            `Nothing was armed: your last restart came back at ${this.when(last.backAt)}, and restarts are ` +
            `at least ${this.cooldownMs / 60_000} minutes apart. The next one can be asked for from ${this.when(next.toISOString())}.`,
        };
      }
    }

    let armed;
    try {
      armed = this.state.arm(this.dataDir, {
        requestedAt: now.toISOString(),
        reason,
        ...(this.hostVersion ? { hostVersion: this.hostVersion } : {}),
      });
    } catch (err) {
      return {
        success: false,
        isError: true,
        error: `Nothing was armed: the request could not be written to the data dir (${err instanceof Error ? err.message : String(err)}).`,
      };
    }

    return {
      success: true,
      data:
        `Restart armed at ${this.when(armed.requestedAt)}. It happens once this turn ends and every agent is idle: ` +
        `the host exits with code ${SELF_RESTART_EXIT_CODE} and its supervisor (${describeSupervisor(this.env)}) starts it again. ` +
        'Your first turn after it rewrites your whole prompt cache once. ' +
        'To disarm it before then, call this again with cancel: true.',
    };
  }

  private when(iso: string): string {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? formatZonedDateTime(d, this.timeZone) : iso;
  }

  private backNote(record: SelfRestartRecord): string {
    const asked = `You restarted yourself: you asked at ${this.when(record.requestedAt)} (reason: ${record.reason})`;
    const back = `back at ${this.when(record.backAt)}`;
    if (!record.cleanExit) {
      return `[self-restart] ${asked}. The host's exit wasn't recorded (it may have crashed or been killed first); ${back}.`;
    }
    const stopped = record.exitReason && record.exitReason !== 'self-restart'
      ? `the host stopped at ${this.when(record.exitedAt!)} for another reason first (${record.exitReason})`
      : `the host stopped at ${this.when(record.exitedAt!)}`;
    return `[self-restart] ${asked}; ${stopped}; ${back}.`;
  }
}
