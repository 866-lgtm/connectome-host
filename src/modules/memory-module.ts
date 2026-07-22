/**
 * MemoryModule — vector memory shared with SillyTavern via memory-service.
 *
 * Talks to the local memory-service (loopback HTTP), which owns embeddings
 * and the Qdrant collections that st-qdrant-memory also reads/writes. The
 * module is a thin, fail-open client with two jobs:
 *
 *   RETRIEVE (gatherContext): when the current turn was triggered by a
 *   message from one of the configured users (Helen), embed-search past
 *   memories for that message's text and inject them as an ephemeral
 *   `system` block (appended to the system prompt, adjacent to where the
 *   autobiographical head/summaries begin). Heartbeat wakes, tool
 *   continuations of other turns, and bot-mention turns get nothing —
 *   matching the "only my turns" policy.
 *   Position history: this started as `afterUser` to keep the prompt-cache
 *   prefix stable, but a block glued to the user's turn gets current-turn
 *   salience — the model reads it as something the user pasted ("the log
 *   you pasted") instead of ambient memory. Top placement costs prefix
 *   cache on injected turns; clarity won.
 *
 *   SAVE (gatherContext + onAgentSpeech): on those same user-triggered
 *   turns, report the user's recent messages and the agent's auto-published
 *   replies to memory-service, which buffers them into ST-compatible chunks.
 *   The service dedups by message id, so re-sending across turns/restarts is
 *   harmless. Messages the agent sends via explicit discord tools
 *   (send_message etc.) are NOT captured — only channels/publish speech.
 *
 * Known trade-off: the retrieval gate keys on the newest stored message with
 * `metadata.triggered === true`. If two wake-triggering messages land before
 * a queued turn runs, the newest one decides — acceptable for a single-user
 * gate.
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  SpeechContext,
} from '@animalabs/agent-framework';
import type { StoredMessage } from '@animalabs/context-manager';
import type { ContextInjection } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MemoryModuleConfig {
  /** memory-service base URL (default: http://127.0.0.1:3102) */
  serviceUrl?: string;
  /** memory-service bot key — selects collection + chunking config (default: 'polaris') */
  bot?: string;
  /** Discord user ids whose turns trigger retrieval and saving (required) */
  userIds: string[];
  /** false = save-only: archive the conversation, never retrieve/inject.
   *  Keeps the prompt-cache prefix stable (default: true) */
  inject?: boolean;
  /** How many recent discord message ids to exclude from retrieval (default: 25) */
  excludeRecentCount?: number;
  /** How many recent user messages to (re)offer for saving each turn (default: 10) */
  saveRecentCount?: number;
  /** Per-request timeout for memory-service calls (default: 3500ms) */
  requestTimeoutMs?: number;
}

interface MemoryModuleState {
  /** Sequence of the newest trigger message already served (survives restarts) */
  lastServedSeq: number;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class MemoryModule implements Module {
  readonly name = 'memory';
  readonly contextTimeoutMs: number;

  private ctx: ModuleContext | null = null;
  private config: Required<MemoryModuleConfig>;
  private lastServedSeq = -1;
  /** Cache so tool-continuation recompiles of the same turn reuse the block */
  private cached: { seq: number; injections: ContextInjection[] } | null = null;
  /** True while the current/most-recent turn passed the user gate */
  private userTurnLive = false;
  /** Channel (MCPL id) of the gate message, for attributing agent speech */
  private liveChannelId: string | undefined;
  private liveGuildId: string | undefined;
  private speechCounter = 0;

  constructor(config: MemoryModuleConfig) {
    this.config = {
      serviceUrl: config.serviceUrl ?? 'http://127.0.0.1:3102',
      bot: config.bot ?? 'polaris',
      userIds: config.userIds,
      excludeRecentCount: config.excludeRecentCount ?? 25,
      saveRecentCount: config.saveRecentCount ?? 10,
      requestTimeoutMs: config.requestTimeoutMs ?? 3500,
      inject: config.inject ?? true,
    };
    this.contextTimeoutMs = this.config.requestTimeoutMs + 500;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const state = ctx.getState<MemoryModuleState>();
    if (state && typeof state.lastServedSeq === 'number') {
      this.lastServedSeq = state.lastServedSeq;
    }
    // additive: observe speech for saving without displacing the handler
    // that publishes it to Discord.
    ctx.registerSpeechHandler('*', { additive: true });
  }

  async stop(): Promise<void> {
    this.ctx?.unregisterSpeechHandler();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    // Passive — no tools, only gatherContext + speech observation.
    return [];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'MemoryModule has no tools', isError: true };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // =========================================================================
  // Retrieve
  // =========================================================================

  async gatherContext(_agentName: string): Promise<ContextInjection[]> {
    if (!this.ctx) return [];

    try {
      const discordMessages = this.recentDiscordMessages();
      const gate = this.findTriggerMessage(discordMessages);
      if (!gate) {
        this.userTurnLive = false;
        return [];
      }

      const author = gate.metadata?.author as { id?: string; name?: string } | undefined;
      const isUserTurn =
        !!author?.id &&
        this.config.userIds.includes(author.id) &&
        gate.metadata?.isBot !== true;

      if (!isUserTurn) {
        this.userTurnLive = false;
        return [];
      }

      // Same turn recompiled (tool continuation): replay the cached block so
      // the context stays consistent within the turn.
      if (this.cached && this.cached.seq === gate.sequence) {
        this.userTurnLive = true;
        return this.cached.injections;
      }
      // Older than what we already served (e.g. heartbeat wake after the
      // user's turn finished): nothing to inject.
      if (gate.sequence <= this.lastServedSeq) {
        this.userTurnLive = false;
        return [];
      }

      const queryText = this.messageText(gate);
      if (!queryText) {
        this.userTurnLive = false;
        return [];
      }

      this.userTurnLive = true;
      this.liveChannelId = gate.metadata?.channelId as string | undefined;
      this.liveGuildId = gate.metadata?.serverId as string | undefined;
      this.speechCounter = 0;
      this.lastServedSeq = gate.sequence;
      this.ctx.setState<MemoryModuleState>({ lastServedSeq: gate.sequence });

      // Save the user's recent messages (service dedups by id) — don't let
      // a save hiccup break retrieval.
      this.saveUserMessages(discordMessages).catch(() => {});

      // Save-only mode (`inject: false`): archive the conversation but never
      // retrieve/inject. Keeps the prompt-cache prefix byte-stable — for
      // agents where a per-turn system-block injection would break the cache
      // on every message (the whole compiled window re-billed as cache
      // writes). Speech capture (onAgentSpeech) still runs via userTurnLive.
      if (this.config.inject === false) {
        this.cached = { seq: gate.sequence, injections: [] };
        return [];
      }

      const excludeIds = discordMessages
        .slice(-this.config.excludeRecentCount)
        .map(m => m.metadata?.messageId as string | undefined)
        .filter((id): id is string => !!id);

      const res = await this.service('/retrieve', {
        bot: this.config.bot,
        query_text: queryText,
        exclude_message_ids: excludeIds,
      });
      const formatted = typeof res.formatted === 'string' ? res.formatted : '';

      const injections: ContextInjection[] = formatted
        ? [{
            namespace: 'memory',
            position: 'system',
            content: [{ type: 'text', text: formatted }],
          }]
        : [];
      this.cached = { seq: gate.sequence, injections };
      return injections;
    } catch (err) {
      // Fail open — never block inference on the memory system.
      console.error('MemoryModule: retrieve failed:', err);
      return [];
    }
  }

  // =========================================================================
  // Save
  // =========================================================================

  async onAgentSpeech(_agentName: string, content: ContentBlock[], context: SpeechContext): Promise<void> {
    // Only the agent's replies on user-gated channel turns become memories —
    // autonomous/heartbeat output stays out of the shared collections.
    if (!this.userTurnLive || context.trigger.reason !== 'mcpl:channel-incoming') return;
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    if (!text) return;

    this.speechCounter += 1;
    const msg: Record<string, unknown> = {
      speaker_kind: 'self',
      text,
      message_id: `self-${this.lastServedSeq}-${this.speechCounter}`,
      ts: Date.now(),
    };
    if (this.liveChannelId) msg.channel_id = this.liveChannelId;
    if (this.liveGuildId) msg.guild_id = this.liveGuildId;

    await this.service('/save', { bot: this.config.bot, messages: [msg] }).catch(err => {
      console.error('MemoryModule: speech save failed:', err);
    });
  }

  private async saveUserMessages(discordMessages: StoredMessage[]): Promise<void> {
    const userMsgs = discordMessages
      .filter(m => {
        const author = m.metadata?.author as { id?: string } | undefined;
        return !!author?.id && this.config.userIds.includes(author.id) && m.metadata?.isBot !== true;
      })
      .slice(-this.config.saveRecentCount);
    if (userMsgs.length === 0) return;

    const messages = userMsgs.map(m => {
      const author = m.metadata?.author as { id?: string; name?: string };
      const out: Record<string, unknown> = {
        speaker_kind: 'user',
        discord_user_id: author.id,
        speaker_name: author.name,
        text: this.messageText(m),
        message_id: m.metadata?.messageId,
        ts: m.timestamp instanceof Date ? m.timestamp.getTime() : Date.now(),
      };
      if (m.metadata?.channelId) out.channel_id = m.metadata.channelId;
      if (m.metadata?.serverId) out.guild_id = m.metadata.serverId;
      return out;
    }).filter(m => m.text && m.message_id);

    if (messages.length > 0) {
      await this.service('/save', { bot: this.config.bot, messages });
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Stored messages that came in through a channel surface (have author metadata), in order. */
  private recentDiscordMessages(): StoredMessage[] {
    if (!this.ctx) return [];
    const { messages } = this.ctx.queryMessages({});
    return messages.filter(m => !!m.metadata?.author && !!m.metadata?.messageId);
  }

  /** Newest message whose arrival triggered inference — the turn's wake cause. */
  private findTriggerMessage(discordMessages: StoredMessage[]): StoredMessage | null {
    for (let i = discordMessages.length - 1; i >= 0; i--) {
      if (discordMessages[i].metadata?.triggered === true) return discordMessages[i];
    }
    return null;
  }

  /** Raw message text: discord-mcpl's rawContent when present, else text blocks. */
  private messageText(m: StoredMessage): string {
    const raw = m.metadata?.rawContent;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    return m.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
  }

  private async service(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.config.serviceUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!res.ok) throw new Error(`memory-service ${path} ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}
