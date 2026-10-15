/**
 * InstructionsModule — injects a shared, living instructions document into
 * every agent's context on every turn.
 *
 * The document is a CLAUDE.md analogue maintained in a workspace mount:
 * operators (or the agents themselves, on a read-write mount) edit one file,
 * and the current content reaches the resident agent AND every ephemeral
 * subagent via the framework's gatherContext hook before each inference.
 * Nothing is persisted to Chronicle — position 'system' injections are
 * per-turn overlays, so edits take effect on the next turn and stale copies
 * never accumulate in history.
 *
 * Fail-open by design: a missing mount, missing file, or any read error
 * yields no injection (never a blocked inference). An agent running without
 * its instructions must not be a silent state, so the first failure for each
 * distinct reason is logged and raised as an `instructions-unavailable` ops
 * alert, which the TUI, the ops webhook and the status channels show; once
 * the file loads again, `instructions-unavailable-clear` stands it down.
 *
 * Requires the workspace module: the configured path is a mount-prefixed
 * workspace path ("<mountName>/<relativePath>"). validateRecipe enforces the
 * pairing. The file is read through WorkspaceModule.readFileFromDisk, which
 * refuses a file that is itself a link unless its mount follows links (a
 * recipe's mounts don't), reads a file only if its canonical path lies
 * inside the mount, and checks that after opening the file, so a link
 * swapped in mid-read can't bring outside content into the trusted
 * instructions block.
 *
 * Reads ask readFileFromDisk for at most maxBytes, so the bound is
 * agent-framework's. At 0.22.1 it holds for a file larger than maxBytes when
 * the read starts, and a file that grows past it during the read is read to
 * its end.
 */

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
import type { ContextInjection } from '@animalabs/context-manager';

/**
 * The slice of WorkspaceModule this module reads through: its disk read,
 * whose refusals are WorkspaceReadErrors (a `code` and a message naming the
 * mount-prefixed path). Structural so tests can stand in for it; production
 * wiring passes the real WorkspaceModule, which satisfies this shape.
 */
export interface WorkspaceDiskReader {
  readFileFromDisk(
    mountPrefixedPath: string,
    options: { maxBytes: number },
  ): Promise<{ bytes: Buffer; size: number; truncated: boolean }>;
}

export interface InstructionsModuleConfig {
  /** Workspace path "<mountName>/<relativePath>". Default "instructions/AGENTS.md". */
  path?: string;
  /** Heading line prepended to the injected block. */
  header?: string;
  /** Truncate content beyond this many bytes (with an explicit marker). Default 32768. */
  maxBytes?: number;
  /** Where the block lands in the compiled context. Default 'system'. */
  position?: 'system' | 'beforeUser' | 'afterUser';
  /** The agent the host runs, whose name the module's ops alerts carry: the
   *  host gives it, as it gives the notices module the same name, which
   *  posts only that agent's alerts. Not a recipe field. */
  agentName?: string;
}

export const DEFAULT_INSTRUCTIONS_PATH = 'instructions/AGENTS.md';
export const DEFAULT_INSTRUCTIONS_HEADER =
  '# Shared operating instructions (live document)';
export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 32768;

export class InstructionsModule implements Module {
  readonly name = 'instructions';

  // gatherContext is one bounded file read — well under 2s. A modest
  // explicit budget keeps a wedged filesystem from eating the registry-wide
  // 15s default before inference proceeds without us.
  readonly contextTimeoutMs = 2000;

  private readonly path: string;
  private readonly header: string;
  private readonly maxBytes: number;
  private readonly position: 'system' | 'beforeUser' | 'afterUser';
  private readonly agentName: string;

  private workspace: WorkspaceDiskReader | null = null;
  private ctx: ModuleContext | null = null;

  /** Reasons already warned about — fail-open must not spam per turn. */
  private warned = new Set<string>();
  /** Whether an instructions-unavailable alert is up, awaiting its clear. */
  private alerted = false;

  constructor(config: InstructionsModuleConfig = {}) {
    this.path = config.path ?? DEFAULT_INSTRUCTIONS_PATH;
    this.header = config.header ?? DEFAULT_INSTRUCTIONS_HEADER;
    this.maxBytes = config.maxBytes ?? DEFAULT_INSTRUCTIONS_MAX_BYTES;
    this.position = config.position ?? 'system';
    this.agentName = config.agentName ?? 'unknown';
  }

  /** Peer injection (same pattern as setFramework/setIdentity elsewhere). */
  setWorkspace(workspace: WorkspaceDiskReader): void {
    this.workspace = workspace;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.warned.clear();
    this.alerted = false;
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    // Passive module — no tools, only gatherContext. The file itself is
    // read/edited through the workspace module's own tools.
    return [];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return {
      success: false,
      error: `InstructionsModule has no tool "${call.name}"`,
      isError: true,
    };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /**
   * Same injection for every agent — resident and ephemeral subagents alike
   * share the one living document (that is the point of the module).
   */
  async gatherContext(_agentName: string): Promise<ContextInjection[]> {
    if (!this.workspace) {
      this.unavailable('the workspace module isn\'t wired, so no instructions can be read');
      return [];
    }
    let read: { bytes: Buffer; size: number; truncated: boolean };
    try {
      read = await this.workspace.readFileFromDisk(this.path, { maxBytes: this.maxBytes });
    } catch (error) {
      // Fail open: missing file or any read error never blocks inference.
      this.unavailable(this.reasonFor(error));
      return [];
    }
    const { bytes, size, truncated } = read;

    let content: string;
    if (truncated) {
      // Back the cut up to a UTF-8 sequence boundary so a multibyte
      // character split at the cap never decodes to U+FFFD right before
      // the marker. The bytes past the cap were never read, so detect a
      // straddle from the kept tail alone: find the last lead byte and
      // drop the sequence iff it declares more bytes than were kept.
      let cut = bytes.length;
      let lead = bytes.length - 1;
      let trailing = 0;
      while (lead >= 0 && (bytes[lead]! & 0xc0) === 0x80) {
        lead--;
        trailing++;
      }
      if (lead >= 0) {
        const b = bytes[lead]!;
        const expected =
          (b & 0x80) === 0 ? 1
          : (b & 0xe0) === 0xc0 ? 2
          : (b & 0xf0) === 0xe0 ? 3
          : (b & 0xf8) === 0xf0 ? 4
          : 1; // invalid lead — leave it; decoding was lossy anyway
        if (expected > trailing + 1) cut = lead;
      }
      content =
        bytes.subarray(0, cut).toString('utf-8') +
        `\n\n[truncated: first ${cut} of ${size} bytes]`;
    } else {
      content = bytes.toString('utf-8');
    }

    // Recovered: stand down an alert that's up, and let a future recurrence
    // of a previous reason warn again.
    this.warned.clear();
    if (this.alerted) {
      this.alerted = false;
      this.notifyOps('instructions-unavailable-clear', `"${this.path}" loaded again; agents have their instructions`);
    }
    return [
      {
        namespace: 'instructions',
        position: this.position,
        content: [{ type: 'text', text: `${this.header}\n\n${content}` }],
      },
    ];
  }

  /** Why the read gave nothing, with what puts it right where the read's
   *  own message (which names the mount-prefixed path) doesn't say. */
  private reasonFor(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'symlink') return `"${this.path}" is a link, which its mount doesn't follow: put the file itself at that path`;
    if (code === 'escape') return `"${this.path}" leads outside its mount: put the file itself at that path`;
    return error instanceof Error ? error.message : String(error);
  }

  /** No instructions this turn: log it and raise one ops alert per distinct
   *  reason, under the host's agent's name, since one loss reaches every
   *  agent it runs, subagents included. */
  private unavailable(reason: string): void {
    if (this.warned.has(reason)) return;
    this.warned.add(reason);
    console.error(`InstructionsModule: no instructions injected: ${reason}`);
    this.alerted = true;
    this.notifyOps('instructions-unavailable', `no instructions injected: ${reason}`);
  }

  /** Through the context object, which the real ModuleContext's notifyOps
   *  reads as `this`; absent on a framework without it. */
  private notifyOps(kind: string, message: string): void {
    this.ctx?.notifyOps?.(kind, this.agentName, message);
  }
}
