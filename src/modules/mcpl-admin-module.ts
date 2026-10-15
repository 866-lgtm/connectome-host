/**
 * McplAdminModule — lets the agent deploy, restart, and unload its own MCPL
 * servers at runtime, without a host restart.
 *
 * Tools:
 *   - mcpl_list                → configured servers + live connection status
 *   - mcpl_deploy {id, ...}    → add/update a server and hot-connect it
 *   - mcpl_restart {id}        → kill + respawn a server (picks up rebuilt dist)
 *   - mcpl_unload {id}         → disconnect a server and remove its tools
 *
 * Persistence model (agent overlay):
 *   Agent deployments are written to `mcpl-servers.agent.json` (cwd), which
 *   index.ts merges over the recipe/file server list at startup — so agent
 *   deployments survive host restarts without touching human-owned recipe
 *   files or mcpl-servers.json. Unloading a recipe/file server writes a
 *   `{disabled: true}` tombstone to the overlay; unloading an agent-deployed
 *   server just deletes its overlay entry.
 *
 * Security: enabling this module in a recipe grants the agent the ability to
 * spawn arbitrary commands as the host user (mcpl_deploy). Recipe opt-in
 * (`modules: { mcplAdmin: true }`) is the permission gate.
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
  AgentFramework,
  McplServerConfig,
} from '@animalabs/agent-framework';
import { resolveTimeZone } from '@animalabs/agent-framework';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_AGENT_OVERLAY_PATH,
  readMcplServersFile,
  readAgentOverlay,
  saveAgentOverlay,
  resolveOverlayEntry,
  composeOverlay,
  serverProvisions,
  lostByReplacement,
  composeMcplChildEnv,
  cleartextCredential,
  cleartextCarrierText,
  overlayEntryProblem,
  overlayEntryReplaces,
  overlayEntryTombstones,
  hostVariableReferences,
  OverlayUnreadableError,
  NAMES_NOTHING,
  type AgentOverlayEntry,
  type ServerProvisions,
} from '../mcpl-config.js';
import { unknownToolResult } from './unknown-tool.js';

export interface McplAdminModuleConfig {
  /** IANA zone propagated to newly deployed stdio servers. */
  timeZone?: string;
  /** Path to the agent overlay file. Default: `mcpl-servers.agent.json` in cwd. */
  overlayPath?: string;
  /** Path to the human-owned server config file (read-only here). */
  configPath?: string;
  /** Where these operations surface to the model: 'tools' (default — four
   *  first-class slots, exactly the historical behavior) or 'utilities'
   *  (behind the framework's single `utils` meta-tool: mcpl management is a
   *  rare operation and needn't tax every inference with four schemas). */
  surface?: 'tools' | 'utilities';
}

function ok(text: string): ToolResult {
  return { success: true, data: text };
}

function fail(text: string): ToolResult {
  return { success: false, error: text, isError: true };
}

/** The module's name. The framework prefixes each of its tools with it, so
 *  the agent calls `mcpl-admin--mcpl_list`, and every result names the tools
 *  that way, so a remedy can be followed as written. */
const MODULE_NAME = 'mcpl-admin';
const tool = (name: string): string => `${MODULE_NAME}--${name}`;
const LIST = tool('mcpl_list');
const DEPLOY = tool('mcpl_deploy');
const RESTART = tool('mcpl_restart');
const UNLOAD = tool('mcpl_unload');

/** A clause as a sentence's end: one full stop, whatever it ended with. */
const sentence = (text: string): string => `${text.trim().replace(/\.+$/, '')}.`;
/** A clause as a sentence's start. */
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** What an error says, for the agent: an unreadable overlay in the agent's
 *  terms (its message is the operator's, for the boot), anything else as it
 *  says itself. */
function reasonText(error: unknown): string {
  if (error instanceof OverlayUnreadableError) {
    return `your overlay file, ${error.path}, ` +
      (error.problem === 'not-json' ? 'isn\'t valid JSON' : 'holds null, not an object with mcplServers');
  }
  return error instanceof Error ? error.message : String(error);
}

/** The repair of an overlay file that can't be read. Some agents can edit
 *  the file, most can't. */
const REPAIR = 'fix the file (or, if you can\'t edit it, ask your operator to)';
const NOT_ASIDE = 'Don\'t move it aside: that would load every server you unloaded and drop your deployments.';

/** What to do about an unreadable overlay, and, after a call `name` it
 *  stopped, to call it again. */
function overlayRepair(name?: string): string {
  return `${capital(REPAIR)}${name ? `, then call ${name} again` : ''}. ${NOT_ASIDE}`;
}

/** The failures with which a write may have stopped partway. The overlay is
 *  written in place (saveAgentOverlay says why), so such a write can leave
 *  the file cut short; the other failures come at the open, before anything
 *  is written. */
const PARTWAY_WRITE = new Set(['ENOSPC', 'EDQUOT', 'EFBIG', 'EIO']);

/** Whether a failed save of the overlay may have stopped partway. */
function partway(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && PARTWAY_WRITE.has(code);
}

/** What a save that may have stopped partway left, as sentences. EIO can
 *  come from the read before the write, and a failure at close after the
 *  whole content went out, so no one guess about the file is true. */
const PARTWAY_TEXT = ' What your overlay file holds now isn\'t known: its old content, the new content whole, or ' +
  `a mix cut short. ${LIST} shows which. If it says the file isn't valid JSON, the next host start will stop on ` +
  `it until it's fixed: ${REPAIR}. ${NOT_ASIDE}`;

/** What takes a server out. An unload removes the agent's own entry, or
 *  tombstones an operator's server, and its receipt says what the next host
 *  start loads: an operator's definition the agent's entry replaced comes
 *  back then, so no more is promised here. */
const UNLOAD_REMEDY = `${UNLOAD} unloads it.`;

/** What fixes a server that won't connect. A restart reconnects with the
 *  configuration of the server's last connect, so a wrong command, args or
 *  url is corrected only by deploying again, while a server rebuilt in place
 *  is picked up by a restart. */
const CONNECT_REMEDY = `If its command, args or url is wrong, call ${DEPLOY} with the right one; if the server ` +
  `itself needs fixing (its build, say), call ${RESTART} once it's fixed. ${UNLOAD_REMEDY}`;

/** What a call has changed so far, for the catch-all. Each step that
 *  changes the overlay file or a server's connection sets `changed` just
 *  before it runs, so a throw that reaches the catch-all after one is never
 *  reported as having changed nothing. */
interface CallProgress {
  changed: boolean;
}

export class McplAdminModule implements Module {
  readonly name = MODULE_NAME;

  private framework: AgentFramework | null = null;
  private overlayPath: string;
  private configPath: string;
  private timeZone: string;

  private surface: 'tools' | 'utilities';

  constructor(config?: McplAdminModuleConfig) {
    this.overlayPath = config?.overlayPath ?? DEFAULT_AGENT_OVERLAY_PATH;
    this.configPath = config?.configPath ?? DEFAULT_CONFIG_PATH;
    this.timeZone = resolveTimeZone(config?.timeZone);
    this.surface = config?.surface ?? 'tools';
  }

  /** Post-creation wiring (called from index.ts, mirrors ActivityModule.setFramework). */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;
  }

  /** Optional identity plumbing (index.ts wires it when the recipe enables
   *  the identity module): lets deployed servers name an `access` grant that
   *  the host turns into a per-dial credential provider. The agent names the
   *  access; credentials never surface. */
  private identity: { accessFor(audience?: string): Promise<string> } | null = null;
  setIdentity(identity: { accessFor(audience?: string): Promise<string> } | null): void {
    this.identity = identity;
  }

  /** The operator's server definitions (recipe and mcpl-servers.json, before
   *  the agent overlay), by what an overlay entry replacing one can lose:
   *  names only, never a credential. index.ts wires it; without it, no
   *  receipt can say what a replacement lacks. */
  private operatorServers = new Map<string, ServerProvisions>();
  /** The same definitions whole, for what the next host start configures. */
  private operatorDefinitions: Array<{ id: string } & Record<string, unknown>> = [];
  setOperatorServers(servers: ReadonlyArray<{ id: string } & Record<string, unknown>>): void {
    this.operatorDefinitions = [...servers];
    this.operatorServers = new Map(servers.map((server) => [server.id, serverProvisions(server)]));
  }

  /**
   * How `id`'s overlay entry stands against the operator's definition it
   * replaces: null when it replaces none, else what it lacks of it (null
   * when nothing). An overlay entry replaces the definition whole, and it
   * can't name host variables, so what it lacks the server runs without.
   */
  private replacement(id: string, overlay: Record<string, AgentOverlayEntry>): { lost: string | null } | null {
    const entry = entryOf(overlay, id);
    const operator = this.operatorServers.get(id);
    if (!operator || !overlayEntryReplaces(entry)) return null;
    return { lost: lostByReplacement(operator, entry) };
  }

  /**
   * What to do about an overlay entry the boot skips. mcpl_unload of it
   * removes it for an id the operator doesn't define, since it loads
   * nothing; for one the operator defines, it tombstones the operator's
   * server, which then stays unloaded.
   */
  private skippedAdvice(id: string): string {
    return this.operatorServers.has(id)
      ? `redeploy with ${DEPLOY} to replace it; ${UNLOAD} would tombstone the operator's definition, so it stays unloaded`
      : `redeploy with ${DEPLOY}, or ${UNLOAD} it`;
  }

  /**
   * How to bring back a tombstoned id. For an id the operator defines, no
   * tool restores the operator's definition: mcpl_deploy loads the agent's
   * own entry in its place, and mcpl_unload writes the tombstone again. Only
   * removing the tombstone from the file does, which most agents can't, and
   * the boot reads the file only at the host's start.
   */
  private tombstoneAdvice(id: string): string {
    return this.operatorServers.has(id)
      ? `${DEPLOY} would load your own entry in its place, and removing the tombstone from your overlay file (or, if ` +
        'you can\'t edit it, asking your operator to) loads the operator\'s definition again at the next host start'
      : `redeploy with ${DEPLOY} to restore it`;
  }

  /**
   * A receipt's sentences about `id`'s overlay entry, or nothing: that it
   * replaces the operator's definition (always on deploy, which makes the
   * replacement; on restart only when it lacks something), what it lacks
   * with the way back, and which of its parts name a host variable, which
   * only a recipe substitutes.
   */
  private overlayNote(id: string, overlay: Record<string, AgentOverlayEntry>, onDeploy: boolean): string {
    const entry = Object.hasOwn(overlay, id) ? overlay[id] : undefined;
    // A malformed entry isn't what this server runs on, and the next start
    // skips it: say so, rather than nothing.
    const problem = entry === undefined ? null : overlayEntryProblem(entry);
    if (problem !== null) {
      return ` Your overlay entry for "${id}" is malformed (${problem}), so the next host start skips it` +
        `${this.operatorServers.has(id) ? ' and loads the operator\'s definition' : ''}; ${this.skippedAdvice(id)}.`;
    }
    // A restart of a tombstoned id is refused, as it isn't loaded: this says
    // why, and that the next start leaves it unloaded too.
    if (!onDeploy && overlayEntryTombstones(entry)) {
      return ` Your overlay tombstones "${id}", so the next host start leaves it unloaded; ${this.tombstoneAdvice(id)}.`;
    }
    if (!overlayEntryReplaces(entry)) return '';
    const replacement = this.replacement(id, overlay);
    const refs = hostVariableReferences(entry);
    const literal = refs.length === 0 ? '' :
      `Your entry names a host variable in ${refs.join(', ')}, and only a recipe substitutes those, ` +
      'so the server gets that text as written.';
    const sentences: string[] = [];
    if (replacement?.lost) {
      sentences.push(
        `Your overlay entry replaces the operator's definition of "${id}" and lacks its ${replacement.lost}, ` +
        'so the server runs without the operator\'s values for them.',
        literal || 'An overlay entry can\'t name host variables.',
        `To go back to the operator's definition, ${UNLOAD} "${id}": that removes your entry, and the ` +
        'operator\'s loads again at the next host start.',
      );
    } else {
      if (replacement && onDeploy) sentences.push(`Your overlay entry replaces the operator's definition of "${id}".`);
      if (literal) {
        sentences.push(literal, 'If the server needs the variable\'s value, ask your operator to add the server to the recipe, ' +
          'which fills host variables in.');
      }
    }
    return sentences.length > 0 ? ` ${sentences.join(' ')}` : '';
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  async stop(): Promise<void> {
    this.framework = null;
  }

  getTools(): ToolDefinition[] {
    return this.surface === 'tools' ? this.definitions() : [];
  }

  /** Same definitions, same handler — the surface flag only decides whether
   *  they cost four slots or ride the `utils` meta-tool. */
  getUtilities(): ToolDefinition[] {
    return this.surface === 'utilities' ? this.definitions() : [];
  }

  private definitions(): ToolDefinition[] {
    return [
      {
        name: 'mcpl_list',
        description:
          'List all MCPL servers: connection/retry state, whether policy was established, ' +
          'the effective grant, masked/denied capability paths, host-command authority, ' +
          'validated manifest revision/fetch/negotiation freshness, tool count, each tool\'s ' +
          'effective class and where it came from, target, and config source.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'mcpl_deploy',
        description:
          'Deploy an MCPL server: persist it to your agent overlay (survives host ' +
          'restarts) and hot-connect it now — its tools become available immediately. ' +
          'If a server with this id is already running it is restarted with the new ' +
          'config. Provide either `command` (stdio, spawned as the host user) or `url` ' +
          '(WebSocket). Relative ./ args resolve against the host working directory. ' +
          'Sensible defaults: omit (or pass empty) the list fields and every feature ' +
          'set and tool the server offers is available; an empty array means ' +
          '"unspecified", never deny-all. Deny-all for tools is disabledTools: ["*"]; ' +
          'in feature-set patterns `*` matches exactly one dot-separated segment, so ' +
          'deny every set with disabledFeatureSets: ["*", "*.*", "*.*.*"] (names up ' +
          'to three segments). Self-deployed servers get channels + tools ' +
          'only — consequential capabilities (context hooks around your inference, ' +
          'server-initiated inference, inference lifecycle) are host-masked; a server ' +
          'that genuinely needs one is an operator conversation, not a deploy flag.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique server id (also the default tool prefix: mcpl--<id>).' },
            command: { type: 'string', description: 'Executable to spawn (stdio transport). Mutually exclusive with url.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the command.' },
            env: { type: 'object', description: 'Environment variables for the spawned process.' },
            url: { type: 'string', description: 'WebSocket URL (websocket transport). Mutually exclusive with command. A user, password or `token` parameter in it is a credential, which mcpl_deploy takes only over wss://, or ws:// to this machine (for example, localhost or a loopback address).' },
            token: { type: 'string', description: 'Token for WebSocket auth, sent as the url\'s `token` parameter (only when the operator hands you one — prefer `access`). mcpl_deploy takes it only with a wss:// url, or ws:// to this machine (for example, localhost or a loopback address).' },
            access: { type: 'string', description: 'Name of a host-managed access grant (e.g. "eidoverse"): the host attaches your standing credentials to the connection automatically. Nothing for you to obtain or handle. mcpl_deploy takes it only with a wss:// url, or ws:// to this machine (for example, localhost or a loopback address).' },
            toolPrefix: { type: 'string', description: 'Tool namespace prefix. Default: mcpl--<id>.' },
            reconnect: { type: 'boolean', description: 'Auto-reconnect on transport failure. Default: true for websocket URLs (a bounced server comes back on its own), false for stdio. Note: does NOT respawn a crashed child — use mcpl_restart for that.' },
            enabledFeatureSets: { type: 'array', items: { type: 'string' }, description: 'Feature-set allowlist (* wildcard). Omit or pass [] for all offered.' },
            disabledFeatureSets: { type: 'array', items: { type: 'string' }, description: 'Feature-set deny-list; wins over enabled.' },
            enabledTools: { type: 'array', items: { type: 'string' }, description: 'Tool allow-list (bare names, * wildcard). Omit or pass [] for all offered.' },
            disabledTools: { type: 'array', items: { type: 'string' }, description: 'Tool deny-list; wins over enabledTools.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'mcpl_restart',
        description:
          'Restart an MCPL server: kill the process and respawn it with its current ' +
          'config. Use after rebuilding a server\'s dist, or to recover a crashed ' +
          'server (reconnect:true does not respawn dead children — this does). ' +
          'CAUTION: restarting the server that carries your active conversation ' +
          '(e.g. discord) briefly interrupts your own message delivery; it reconnects ' +
          'within a few seconds.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Server id to restart.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'mcpl_unload',
        description:
          'Unload an MCPL server: disconnect it and remove its tools from your ' +
          'toolset. By default this persists (an unloaded recipe server stays ' +
          'unloaded after host restarts; an agent-deployed server is deleted from ' +
          'your overlay). Pass persist:false to unload for this session only. ' +
          'WARNING: unloading the server that carries your conversation (e.g. ' +
          'discord) cuts your own communication channel — you would need another ' +
          'route (or a human) to get it back.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Server id to unload.' },
            persist: { type: 'boolean', description: 'Persist across host restarts (default true).' },
          },
          required: ['id'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const progress: CallProgress = { changed: false };
    try {
      switch (call.name) {
        case 'mcpl_list':
          return this.handleList();
        case 'mcpl_deploy':
          return await this.forServer(input, () => this.handleDeploy(input, progress));
        case 'mcpl_restart':
          return await this.forServer(input, () => this.handleRestart(input, progress));
        case 'mcpl_unload':
          return await this.forServer(input, () => this.handleUnload(input, progress));
        default:
          return unknownToolResult(this, call.name);
      }
    } catch (error) {
      // Each step that changes something (the overlay's save, a connect or
      // restart, a disconnect, the unload's record) catches its own failure
      // and says what it changed. Whether one had run when this throw came is
      // the call's own record, not an assumption about which reads can throw.
      const repair = error instanceof OverlayUnreadableError ? ` ${overlayRepair(tool(call.name))}` : '';
      if (progress.changed) {
        return fail(
          `${tool(call.name)} failed partway: ${sentence(reasonText(error))} What it changed before then stays ` +
          `changed; ${LIST} shows each server's state.${repair}`,
        );
      }
      const failed = call.name === 'mcpl_list' ? 'failed' : 'failed, and nothing was changed';
      return fail(`${tool(call.name)} ${failed}: ${sentence(reasonText(error))}${repair}`);
    }
  }

  /** The tail of each server id's queue of deploy, restart and unload calls. */
  private readonly serverQueues = new Map<string, Promise<void>>();

  /**
   * Run `work` once every earlier deploy, restart or unload of the same id
   * has settled, so two calls for one server never interleave. An unload's
   * disconnect is never overtaken by a deploy that connects the server again,
   * which its overlay entry, identical or not, can't reveal, and a deploy's
   * connect is never overtaken by an unload that removes its entry. Calls
   * for other ids run as before.
   */
  private forServer(input: Record<string, unknown>, work: () => Promise<ToolResult>): Promise<ToolResult> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return work();
    const run = (this.serverQueues.get(id) ?? Promise.resolve()).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.serverQueues.set(id, tail);
    void tail.then(() => { if (this.serverQueues.get(id) === tail) this.serverQueues.delete(id); });
    return run;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private requireFramework(): AgentFramework {
    // index.ts wires the framework before it starts, so a call meets none
    // only after stop(): at shutdown, or when a session switch replaces the
    // framework and its modules. Calling again here can't help.
    if (!this.framework) {
      throw new Error(
        'the MCPL admin tools have stopped, as they do when this host shuts down or switches sessions, so they ' +
        'can\'t act',
      );
    }
    return this.framework;
  }

  private handleList(): ToolResult {
    const framework = this.requireFramework();
    // These fields land in agent-framework 0.8's MCPL grant work. Keep them
    // optional here so connectome-host remains truthful ("unknown") if it is
    // temporarily run against an older framework package during rollout.
    const live = framework.listMcplServers() as Array<
      ReturnType<AgentFramework['listMcplServers']>[number] & {
        retrying?: boolean;
        policyEstablished?: boolean;
        effectiveGrant?: string[];
        maskedCapabilities?: string[];
        deniedCapabilities?: string[];
        allowHostCommands?: boolean;
        manifestState?: {
          lastValidatedRevision: string | null;
          lastFetchedAt: number | null;
          lastNegotiatedAt: number | null;
        };
        toolClasses?: ServerToolClass[];
      }
    >;
    const overlay = readAgentOverlay(this.overlayPath);
    let fileServers: ReturnType<typeof readMcplServersFile>;
    try {
      fileServers = readMcplServersFile(this.configPath);
    } catch (error) {
      // The operator's file, which the boot read at its start. Of these
      // tools, only this listing reads it again, for each server's source.
      return fail(
        `${LIST} failed: the operator's server file couldn't be read (${reasonText(error)}). ` +
        `It's theirs to fix, so ask your operator. ${DEPLOY}, ${RESTART} and ${UNLOAD} don't read it, and still work.`,
      );
    }

    const lines: string[] = [];
    for (const s of live) {
      // The overlay is the source only for an entry that put a server in
      // place, the same test the boot's applyAgentOverlay makes.
      const replacement = this.replacement(s.id, overlay);
      const overlaySource = replacement
        ? `agent-overlay (replaces the operator's definition${replacement.lost ? `; lacks its ${replacement.lost}` : ''})`
        : 'agent-overlay';
      const source = overlayEntryReplaces(entryOf(overlay, s.id))
        ? overlaySource
        : Object.hasOwn(fileServers, s.id) ? 'file/recipe' : 'recipe';
      // The command, else the url, as main labelled it. The framework's status
      // carries no transport, so for a definition that names both, this can't
      // tell which one the framework opened.
      const target = s.command ?? s.url ?? '?';
      const connectionState = s.connected ? 'CONNECTED' : s.retrying ? 'RETRYING' : 'DISCONNECTED';
      const policyState = s.policyEstablished === undefined
        ? 'unknown'
        : s.policyEstablished ? 'established' : 'not-established';
      const hostCommands = s.allowHostCommands === undefined
        ? 'unknown'
        : s.allowHostCommands ? 'allow' : 'deny';
      lines.push(
        `${s.id}: ${connectionState} — policy=${policyState}, ` +
        `grant=${formatCapabilityList(s.effectiveGrant)}, ` +
        `masked=${formatCapabilityList(s.maskedCapabilities)}, ` +
        `denied=${formatCapabilityList(s.deniedCapabilities)}, ` +
        `hostCommands=${hostCommands}, ` +
        `manifest=${formatManifestState(s.manifestState)}; ${s.toolCount} tools, ` +
        `classes=${formatServerToolClasses(s.toolClasses)}, ` +
        `prefix=${s.toolPrefix}, source=${source}, ${target}`,
      );
    }

    // The overlay's entries the live list doesn't explain: malformed ones,
    // tombstones, and entries that aren't currently loaded
    const liveIds = new Set(live.map(s => s.id));
    for (const [id, entry] of Object.entries(overlay)) {
      const problem = overlayEntryProblem(entry);
      if (problem !== null) {
        lines.push(
          `${id}: MALFORMED in your overlay (${problem}), so the boot skips it` +
          `${this.operatorServers.has(id) ? ' and loads the operator\'s definition' : ''} — ${this.skippedAdvice(id)}`,
        );
      } else if (overlayEntryTombstones(entry)) {
        // A tombstone written while its server runs leaves it connected for
        // this session, which the line above already shows.
        lines.push(liveIds.has(id)
          ? `${id}: TOMBSTONED in your overlay, still connected this session; the next host start leaves it unloaded — ${this.tombstoneAdvice(id)}`
          : `${id}: UNLOADED (tombstoned in your overlay — ${this.tombstoneAdvice(id)})`);
      } else if (!liveIds.has(id)) {
        lines.push(`${id}: NOT LOADED (in your overlay but not connected — try ${DEPLOY} again)`);
      }
    }

    if (lines.length === 0) {
      return ok(`No MCPL servers are loaded. Use ${DEPLOY} to add one.`);
    }
    return ok(`MCPL servers (${lines.length}):\n` + lines.map(l => `  ${l}`).join('\n'));
  }

  private async handleDeploy(input: Record<string, unknown>, progress: CallProgress): Promise<ToolResult> {
    const framework = this.requireFramework();
    // Every problem with the call's arguments goes into one refusal, so an
    // agent corrects them in one call: a key the tool doesn't declare, the
    // id, the command or url, an access grant this host can't serve, each
    // malformed field, and a tool prefix another holds. Only the cleartext
    // check comes after, since it reads a url the refusal has found valid.
    const problems: string[] = [];
    // A key the tool doesn't declare is refused rather than dropped, so a
    // misspelled one (`disabledTool`, say) can't leave the server without
    // what it was meant to set. The keys are the tool's own, so they can't
    // drift from its definition.
    const declared = Object.keys(
      (this.definitions().find((d) => d.name === 'mcpl_deploy')!.inputSchema as { properties: object }).properties,
    );
    const undeclared = Object.keys(input).filter((k) => !declared.includes(k));
    if (undeclared.length > 0) {
      problems.push(
        `${undeclared.map((k) => JSON.stringify(k)).join(', ')} ${undeclared.length === 1 ? 'isn\'t a field' : 'aren\'t fields'} ` +
        `of ${DEPLOY}, which takes ${declared.join(', ')}.`,
      );
    }
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    let idOk = false;
    if (!id) {
      problems.push(
        '`id` is missing or empty, or isn\'t text: give the server\'s name as text, such as "my-server", in letters, ' +
        'digits, _ and -, since it becomes part of its tools\' names.',
      );
    } else if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      // The id with each run of other characters as one -, as a name to copy.
      const cleaned = id.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      problems.push(
        `The id ${JSON.stringify(id)} has characters other than letters, digits, _ and -, and it becomes part of ` +
        `tool names: use one such as ${JSON.stringify(cleaned && cleaned !== '__proto__' ? cleaned : 'my-server')}.`,
      );
    } else if (id === '__proto__') {
      // The one name the pattern admits that JavaScript doesn't take as a
      // key: `overlay["__proto__"] = entry` sets the overlay's prototype, so
      // the entry would never be saved.
      problems.push(
        '"__proto__" can\'t be a server id, since JavaScript reads it as an object\'s prototype rather than a name: ' +
        'choose another.',
      );
    } else {
      idOk = true;
    }

    // Each field the caller gives is judged as given, by the strict reading
    // below, rather than dropped or coerced into shape first, so a wrong kind
    // is refused instead of vanishing. A field is unspecified when it's left
    // out, null, or what strict function calling sends for its own kind when
    // every field is required: "" (or only spaces) for a text field, [] for
    // a list (env included, as before). Anything else is given, so "" for a
    // list or for reconnect, which has no unspecified value, is a wrong kind,
    // not a default. A persisted empty enabledFeatureSets would be deny-all
    // under the §5.3 pin (Mica's silently eventless eidoverse, 2026-08-04),
    // and so would a name list holding an empty name, which the strict
    // reading refuses; deny-all is disabledTools: ["*"] for tools, and for
    // feature sets, where `*` matches one dot-separated segment, a pattern
    // per depth (see resolveOverlayEntry). Numbers and true/false in a list
    // are read as their text, as the boot reads args.
    const given = (v: unknown): boolean => v !== undefined && v !== null;
    const givenText = (v: unknown): boolean => given(v) && !(typeof v === 'string' && v.trim() === '');
    const givenList = (v: unknown): boolean => given(v) && !(Array.isArray(v) && v.length === 0);
    const list = (v: unknown): unknown =>
      Array.isArray(v) ? v.map((x) => (typeof x === 'number' || typeof x === 'boolean' ? String(x) : x)) : v;

    const command = givenText(input.command) ? input.command : undefined;
    const url = givenText(input.url) ? input.url : undefined;
    if (command === undefined && url === undefined) {
      problems.push(
        'Neither `command` nor `url` was given, or both were empty: give `command`, the executable to spawn for a ' +
        'stdio server, or `url`, the ws:// or wss:// address of a WebSocket server.',
      );
    } else if (command !== undefined && url !== undefined) {
      problems.push(
        'Both `command` and `url` were given: give one, since a server is either spawned from a command (stdio) or ' +
        'dialled at a url (WebSocket).',
      );
    }
    // agent-framework dials only a url that parses as ws:// or wss://. Its
    // rule is buildWebSocketUrl's (transport.ts:357-373 at 0.22.1), restated
    // here since it isn't exported: compare the two when either changes. A
    // url it can't dial would be saved, and with reconnect, a url's default,
    // the first dial's failure leaves a stub retrying a url that never opens.
    // The url isn't quoted back: it can hold a credential.
    if (typeof url === 'string') {
      let scheme: string | null = null;
      try {
        scheme = new URL(url).protocol;
      } catch {
        // It doesn't parse.
      }
      if (scheme !== 'ws:' && scheme !== 'wss:') {
        problems.push(
          `\`url\` ${scheme === null ? 'doesn\'t parse as a url' : `begins ${JSON.stringify(scheme)}, not ws: or wss:`}: ` +
          'give the server\'s ws:// or wss:// address.',
        );
      }
    }

    const fields: Record<string, unknown> = {};
    if (command !== undefined) fields.command = command;
    if (url !== undefined) { fields.url = url; fields.transport = 'websocket'; }
    if (givenList(input.args)) fields.args = list(input.args);
    if (givenList(input.env)) fields.env = input.env;
    if (givenText(input.token)) fields.token = input.token;
    if (typeof input.access === 'string' ? input.access.trim() !== '' : given(input.access)) {
      if (typeof input.access === 'string' && !this.identity) {
        problems.push(
          '`access` names a host-managed access grant, but this host has no identity configured to supply its ' +
          'credential: leave `access` out, give the server\'s `token` instead (taken only over wss://, or ws:// to ' +
          'this machine), or ask your operator to enable identity (recipe `identity`).',
        );
      } else {
        fields.access = typeof input.access === 'string' ? input.access.trim() : input.access;
      }
    }
    if (givenText(input.toolPrefix)) fields.toolPrefix = input.toolPrefix;
    if (given(input.reconnect)) fields.reconnect = input.reconnect;
    for (const k of ['enabledFeatureSets', 'disabledFeatureSets', 'enabledTools', 'disabledTools']) {
      if (givenList(input[k])) fields[k] = list(input[k]);
    }

    // Never save an entry the boot would skip: what loads now must be what
    // loads at the next start. Without this, an env value such as null was
    // saved, resolveOverlayEntry returned null for it, and the deploy threw
    // after saving. A new write is held to
    // the plain shapes (strict), though the boot reads older files leniently.
    // The reading's own "no command or url" is said above already.
    const problem = overlayEntryProblem(fields, { strict: true });
    const malformed = problem !== null && problem !== NAMES_NOTHING;
    if (malformed) problems.push(`The entry would be malformed: ${problem}.`);

    // The overlay, for the prefix check and the save. One that can't be read
    // stops the call here, through the catch-all, before anything changes.
    const overlay = readAgentOverlay(this.overlayPath);
    if (idOk && (fields.toolPrefix === undefined || typeof fields.toolPrefix === 'string')) {
      const prefix = typeof fields.toolPrefix === 'string' ? fields.toolPrefix : `mcpl--${id}`;
      const holder = this.prefixHolder(framework, id, prefix, overlay);
      if (holder) {
        problems.push(
          `Its tool prefix "${prefix}"${fields.toolPrefix === undefined ? ', the default for this id,' : ''} is ` +
          `${holder}, and agent-framework refuses a prefix two hold, so the next host start would stop on it: give ` +
          '`toolPrefix` a name of its own.',
        );
      }
    }
    if (problems.length > 0) {
      return fail(
        `Nothing was deployed or saved: ${problems.join(' ')} Correct ${problems.length === 1 ? 'it' : 'each'}` +
        `${malformed ? ' (or leave out a field the server can do without)' : ''} and call ${DEPLOY} again.`,
      );
    }
    const entry = fields as AgentOverlayEntry;

    // A credential sent over ws:// to another machine (cleartextCredential
    // names the carriers it recognizes) can be read by anyone on the network
    // between. A deploy doesn't send one there. An operator who knows that
    // network is private can put the server in the recipe, where it loads
    // with a warning.
    const cleartext = cleartextCredential(entry);
    if (cleartext) {
      const configured = framework.listMcplServers().some(s => s.id === id);
      return fail(
        `Nothing was deployed: ${cleartextCarrierText(cleartext.carrier, entry.access)} would go to ${cleartext.host} ` +
        'over unencrypted ws://, where anyone on the network between can read it, so nothing was saved.' +
        (configured ? ` The server already configured as "${id}" is unchanged.` : '') +
        ' Use a wss:// url, or, if that network is private, ask your operator to add the server to the recipe.',
      );
    }

    // Persist to the overlay first — a connect failure still leaves the entry
    // in place, so the agent can fix the server and restart it, or deploy
    // again with what was wrong corrected.
    overlay[id] = entry;
    progress.changed = true;
    try {
      saveAgentOverlay(this.overlayPath, overlay);
    } catch (error) {
      return fail(
        `Nothing was deployed: saving your overlay failed (${reasonText(error)}), so no server was connected or ` +
        `restarted. Once that's fixed, call ${DEPLOY} again; if you can't fix it, ask your operator.` +
        `${partway(error) ? PARTWAY_TEXT : ''}`,
      );
    }

    const config = resolveOverlayEntry(id, entry, this.overlayPath) as unknown as McplServerConfig;
    // The child's env as the boot composes it for every server
    // (composeMcplChildEnv): the refusal-reaction baseline as a default the
    // entry's own env overrides, and the host's AGENT_TIMEZONE over both.
    config.env = composeMcplChildEnv(config.env as Record<string, string> | undefined, this.timeZone);
    if (entry.access && this.identity) {
      const identity = this.identity;
      const audience = entry.access;
      // Fresh credential on every dial, resolved host-side; the overlay
      // stores only the access NAME. See identity-module.ts header.
      config.accessProvider = () => identity.accessFor(audience);
    }

    const alreadyLoaded = framework.listMcplServers().some(s => s.id === id);
    const note = this.overlayNote(id, overlay, true);
    try {
      if (alreadyLoaded) {
        await framework.restartMcplServer(id, config);
      } else {
        await framework.connectMcplServer(config);
      }
    } catch (error) {
      return fail(
        `Server "${id}" was saved to your overlay, but ${alreadyLoaded ? 'restarting it with that entry' : 'connecting it'} ` +
        `failed: ${sentence(reasonText(error))} ${this.afterFailure(framework, id, false)}${note}`,
      );
    }

    // A server with reconnect whose first dial failed comes back as a stub
    // that keeps retrying, without throwing: report what the status says.
    const status = framework.listMcplServers().find(s => s.id === id);
    if (!status?.connected) {
      return fail(
        `Server "${id}" was saved to your overlay, but it isn't connected` +
        `${status?.retrying ? `; it keeps retrying on its own, so it may still connect, which ${LIST} shows` : ''}. ` +
        `${CONNECT_REMEDY}${note}`,
      );
    }
    return ok(
      `${alreadyLoaded ? 'Redeployed' : 'Deployed'} server "${id}" — connected, ` +
      `${status.toolCount} tools under prefix ${status.toolPrefix}. ` +
      `Persisted to your agent overlay (survives host restarts).${note}`,
    );
  }

  private async handleRestart(input: Record<string, unknown>, progress: CallProgress): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return fail(`Nothing was restarted: ${RESTART} needs \`id\` as text, the server's id as ${LIST} shows it.`);

    // The overlay is read before the restart, so a restart that throws still
    // carries what it says, and an overlay file that can't be read costs only
    // that: the restart's own outcome is what the receipt reports. Neither
    // error readAgentOverlay throws quotes the file.
    let overlay: Record<string, AgentOverlayEntry> | null = null;
    let unreadable = '';
    try {
      overlay = readAgentOverlay(this.overlayPath);
    } catch (error) {
      // readAgentOverlay throws only where the boot does too: a file it
      // can't read, that isn't JSON, or whose root is null. So the next
      // start stops on it.
      unreadable = ` ${capital(sentence(reasonText(error)))} Nothing is said here about your entry, and the next host ` +
        `start will stop on the file until it's fixed.${error instanceof OverlayUnreadableError ? ` ${overlayRepair()}` : ''}`;
    }
    // agent-framework restarts only a server it holds a configuration for,
    // and listMcplServers lists exactly those, so this is its own test, made
    // first so the refusal can say what is loaded and what to do instead.
    const loaded = framework.listMcplServers().map((s) => s.id);
    if (!loaded.includes(id)) {
      return fail(
        `Nothing was restarted: no server "${id}" is loaded in this session. ` +
        `${loaded.length > 0 ? `Loaded: ${loaded.map((s) => `"${s}"`).join(', ')}.` : 'None is loaded.'}` +
        `${overlay ? this.notLoadedAdvice(id, overlay) : unreadable}`,
      );
    }
    let note = unreadable;
    if (overlay) {
      note = this.overlayNote(id, overlay, false);
      // The restart reconnects with the configuration of the server's last
      // connect, while the note reads the file as it is now. An edit made
      // before that connect is already in it. That's said of a replacing
      // entry only: a skipped one takes no effect, and a tombstoned id has no
      // configuration left to reconnect with once unloaded.
      if (note && overlayEntryReplaces(entryOf(overlay, id))) {
        note += ' That describes your overlay file as it is now. The restart reconnects with the configuration of the ' +
          `server's last connect, at this host's start or your last ${DEPLOY} of it, so a hand edit made since then ` +
          `takes effect at the next host start, unless a later ${DEPLOY} replaces it.`;
      }
    }
    progress.changed = true;
    try {
      await framework.restartMcplServer(id);
    } catch (error) {
      return fail(
        `The restart of "${id}" didn't complete: ${sentence(reasonText(error))} ` +
        `${this.afterFailure(framework, id, true, overlay ?? undefined)}${note}`,
      );
    }
    const status = framework.listMcplServers().find(s => s.id === id);
    if (!status?.connected) {
      return fail(
        `Restarted server "${id}", but it isn't connected` +
        `${status?.retrying ? `; it keeps retrying on its own, so it may still connect, which ${LIST} shows` : ''}. ` +
        `${CONNECT_REMEDY}${note}`,
      );
    }
    return ok(`Restarted server "${id}" — connected, ${status.toolCount} tools.${note}`);
  }

  /**
   * What a failed connect or restart left of `id`, read from the framework
   * rather than guessed, with the next step. agent-framework can leave the
   * server running its previous configuration (a restart whose first step,
   * reading its ledger, failed before it disconnected), without one (a
   * failure before the configuration was stored, such as a toolPrefix
   * collision, or a restart's connect after the disconnect removed it), or
   * configured but down. A restart passes the overlay it read, if it could,
   * for what the next host start loads.
   */
  private afterFailure(
    framework: AgentFramework,
    id: string,
    restart: boolean,
    restartOf?: Record<string, AgentOverlayEntry>,
  ): string {
    let status: { connected: boolean; retrying: boolean } | undefined;
    try {
      status = framework.listMcplServers().find((s) => s.id === id);
    } catch {
      return `What state it's in now is unknown; ${LIST} shows it.`;
    }
    if (status?.connected) {
      return restart
        ? `It's still running as it was: once the cause is fixed, call ${RESTART} again.`
        : 'It\'s still running its previous configuration: your new entry is saved, and the next host start loads ' +
          `it, but it isn't in effect now. Once the cause is fixed, call ${DEPLOY} again to apply it.`;
    }
    if (!status) {
      // A restart's advice is the restart refusal's for an id that isn't
      // loaded, by what defines it. A deploy reads the overlay before it
      // saves, so with the file unreadable it can't load the server yet.
      if (restart) {
        return `It isn't loaded in this session any more, so ${RESTART} can't reach it.` +
          (restartOf
            ? this.notLoadedAdvice(id, restartOf)
            : ` ${DEPLOY} with its command or url can load it again once your overlay file is fixed.`);
      }
      return `It isn't loaded in this session, so ${RESTART} can't reach it. Your entry is saved, so the next host ` +
        `start loads it; once the cause is fixed, call ${DEPLOY} again to load it now. ${UNLOAD} removes the saved ` +
        'entry.';
    }
    const retrying = status.retrying ? `; it keeps retrying on its own, so it may still connect, which ${LIST} shows` : '';
    if (restart) return `It isn't connected${retrying}. ${CONNECT_REMEDY}`;
    // After a failed redeploy the framework may hold the server's previous
    // configuration (a restart that stopped before its disconnect) or the
    // new one, so a restart could reconnect either; a deploy applies the
    // saved entry whichever it holds.
    return `It isn't connected${retrying}. Your entry is saved, and the next host start loads it; once the cause is ` +
      `fixed, call ${DEPLOY} again to apply it now. ${UNLOAD_REMEDY}`;
  }

  /** What else holds `prefix`, as a phrase, if `id` deployed with it would
   *  share it: a module, or another server the next host start configures
   *  (the operator's, as this host's start composed them, under the
   *  overlay's other entries) or that's loaded now. agent-framework's
   *  create() refuses a prefix two hold, so the next start would stop on it
   *  (framework.ts:2361-2377 at 0.22.1); connectMcplServer refuses it too,
   *  but only after the save. */
  private prefixHolder(
    framework: AgentFramework,
    id: string,
    prefix: string,
    overlay: Record<string, AgentOverlayEntry>,
  ): string | null {
    if (framework.getModule(prefix)) return `the name of the host's module "${prefix}"`;
    const prefixOf = (s: { id: string; toolPrefix?: unknown }): string =>
      typeof s.toolPrefix === 'string' ? s.toolPrefix : `mcpl--${s.id}`;
    // This deploy's entry replaces whatever `id` had, so only the others count.
    const others = Object.fromEntries(Object.entries(overlay).filter(([key]) => key !== id));
    const nextStart = composeOverlay(this.operatorDefinitions, others, this.overlayPath);
    const other = [...nextStart, ...framework.listMcplServers()].find((s) => s.id !== id && prefixOf(s) === prefix);
    return other ? `server "${other.id}"'s` : null;
  }

  /** The next step for an id a restart found unloaded, by what defines it. */
  private notLoadedAdvice(id: string, overlay: Record<string, AgentOverlayEntry>): string {
    const entry = entryOf(overlay, id);
    // A malformed or tombstoning entry: as the overlay note says it.
    if (entry !== undefined && (overlayEntryProblem(entry) !== null || overlayEntryTombstones(entry))) {
      return this.overlayNote(id, overlay, false);
    }
    if (overlayEntryReplaces(entry)) {
      return ` Your overlay has an entry for "${id}", so the next host start loads it; ${DEPLOY} with its command ` +
        'or url loads it now.';
    }
    if (this.operatorServers.has(id)) {
      return ` Your operator defines "${id}", so the next host start loads it again; ${DEPLOY} would load your own ` +
        'entry in its place now.';
    }
    return ` Neither your overlay nor your operator defines "${id}".`;
  }

  /** What the next host start loads for `id`, read from `overlay` as this
   *  call leaves it, as a clause for a receipt. */
  private nextStart(id: string, overlay: Record<string, AgentOverlayEntry>): string {
    const entry = entryOf(overlay, id);
    if (overlayEntryTombstones(entry)) return 'your overlay tombstones it, so the next host start leaves it unloaded.';
    if (overlayEntryReplaces(entry)) return 'your overlay entry loads it again at the next host start.';
    if (this.operatorServers.has(id)) return 'the operator\'s definition loads it again at the next host start.';
    return 'nothing loads it at the next host start.';
  }

  private async handleUnload(input: Record<string, unknown>, progress: CallProgress): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return fail(`Nothing was unloaded: ${UNLOAD} needs \`id\` as text, the server's id as ${LIST} shows it.`);
    // As for mcpl_deploy: `overlay["__proto__"] = …` would set the prototype,
    // so a tombstone for it would never be saved.
    if (id === '__proto__') {
      return fail(
        'Nothing was unloaded: your overlay can\'t record "__proto__", which JavaScript reads as an object\'s ' +
        'prototype rather than a name, so no server by that id can be unloaded here.',
      );
    }
    const persist = input.persist !== false;

    const loaded = framework.listMcplServers().map((s) => s.id);
    const known = loaded.includes(id);
    const operator = this.operatorServers.has(id);
    // Read before anything changes: a file the boot would stop on refuses
    // the unload here, with the server still loaded. An operator's server
    // that isn't loaded can still be unloaded, so that it stays unloaded at
    // the next start: one that failed to start, or one whose earlier unload
    // disconnected it but couldn't save.
    const overlay = readAgentOverlay(this.overlayPath);
    if (!known && !operator && entryOf(overlay, id) === undefined) {
      return fail(
        `Nothing was unloaded: no server "${id}" is loaded, defined by your operator, or in your overlay. ` +
        `${loaded.length > 0 ? `Loaded: ${loaded.map((s) => `"${s}"`).join(', ')}.` : 'None is loaded.'}`,
      );
    }

    // Only a listed server is disconnected: an id the overlay alone names
    // has nothing loaded. The overlay changes only once the server is gone,
    // so a disconnect that fails changes nothing.
    if (known) {
      progress.changed = true;
      try {
        await framework.disconnectMcplServer(id);
      } catch (error) {
        return fail(
          `Server "${id}" couldn't be disconnected: ${sentence(reasonText(error))} It may still be loaded in this ` +
          `session, and this unload changed nothing in your overlay. ${LIST} shows whether it's loaded; call ` +
          `${UNLOAD} again to retry.`,
        );
      }
    }
    const head = known
      ? `Unloaded server "${id}" — its tools are gone from your toolset.`
      : `Server "${id}" wasn't loaded in this session.`;
    if (!persist) return ok(`${head} Session-only: ${this.nextStart(id, overlay)}`);

    // Read again after the disconnect and saved with nothing awaited between,
    // so a write for another id that landed meanwhile (its deploy, say) is
    // kept. No call for this id can land meanwhile (forServer). The server
    // is already gone if this fails, so the receipt says so, and what the
    // next start loads; an unload of it again records it.
    progress.changed = true;
    try {
      const current = known ? readAgentOverlay(this.overlayPath) : overlay;
      const entry = entryOf(current, id);
      // An agent-deployed entry is removed, and so is a malformed one for an
      // id the operator doesn't define, which loads nothing. Otherwise a
      // tombstone keeps it unloaded: the operator's server, a malformed entry
      // the boot would skip for the operator's, or a server whose definition
      // this module can't see.
      if (overlayEntryReplaces(entry) || (entry !== undefined && !operator && overlayEntryProblem(entry) !== null)) {
        const restores = operator && overlayEntryReplaces(entry);
        delete current[id];
        saveAgentOverlay(this.overlayPath, current);
        return ok(`${head} ${restores
          ? `Removed from your agent overlay; the operator's definition of "${id}" loads again at the next host start.`
          : 'Removed from your agent overlay.'}`);
      }
      current[id] = { disabled: true };
      saveAgentOverlay(this.overlayPath, current);
      return ok(`${head} Tombstoned in your overlay — it stays unloaded across host restarts; ${this.tombstoneAdvice(id)}.`);
    } catch (error) {
      // A save that may have stopped partway leaves the file's content, and
      // so what the next start loads, unknown.
      return fail(
        `${head} ${partway(error)
          ? `But saving your overlay failed (${reasonText(error)}).${PARTWAY_TEXT}`
          : `But your overlay couldn't be updated (${reasonText(error)}), so the unload isn't recorded: ` +
            this.nextStart(id, overlay)} ${UNLOAD} "${id}" again records it once the file can be read and written.` +
        `${error instanceof OverlayUnreadableError ? ` ${overlayRepair()}` : ''}`,
      );
    }
  }
}

/** `id`'s own entry in an overlay: never a name the map inherits, such as
 *  `toString`. */
function entryOf(overlay: Record<string, AgentOverlayEntry>, id: string): AgentOverlayEntry | undefined {
  return Object.hasOwn(overlay, id) ? overlay[id] : undefined;
}

/** One of a server's tools with its effective class (RFC-008 §6), as
 *  listMcplServers() reports it on frameworks with tool classes. */
interface ServerToolClass {
  tool: string;
  serverTool: string;
  class: string[];
  source: 'override' | 'host' | 'server' | 'none';
}

/**
 * A server's tools grouped by effective class and source, e.g.
 * `{comms/server: say,send; media/override: render; unclassed: probe}`.
 * Sources: `server` = the server's own `_meta["mcpl/class"]`, `override` =
 * the operator's recipe override; unclassed tools never expose their
 * arguments to lifecycle observers. `unknown` on an older framework.
 */
function formatServerToolClasses(rows: ServerToolClass[] | undefined): string {
  if (rows === undefined) return 'unknown';
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.class.length === 0 ? 'unclassed' : `${r.class.join('+')}/${r.source}`;
    const names = groups.get(key) ?? [];
    names.push(r.serverTool || r.tool);
    groups.set(key, names);
  }
  const parts = [...groups.entries()].map(([key, names]) => `${key}: ${names.join(',')}`);
  return `{${parts.join('; ')}}`;
}

function formatCapabilityList(paths: string[] | undefined): string {
  if (paths === undefined) return 'unknown';
  return `[${paths.join(',')}]`;
}

function formatManifestState(state: {
  lastValidatedRevision: string | null;
  lastFetchedAt: number | null;
  lastNegotiatedAt: number | null;
} | undefined): string {
  if (state === undefined) return 'unknown';
  return `{revision=${formatManifestRevision(state.lastValidatedRevision)},` +
    `fetchedAt=${formatManifestTimestamp(state.lastFetchedAt)},` +
    `negotiatedAt=${formatManifestTimestamp(state.lastNegotiatedAt)}}`;
}

/** Bound and quote the server-authored, equality-only revision before putting
 * it on a model-facing text surface. Conforming revisions fit well below the
 * limit; malformed peers cannot inject control lines or unbounded text. */
function formatManifestRevision(revision: string | null): string {
  if (revision === null) return 'none';
  const bounded = revision.length <= 64 ? revision : `${revision.slice(0, 61)}...`;
  return JSON.stringify(bounded);
}

function formatManifestTimestamp(timestamp: number | null): string {
  if (timestamp === null) return 'none';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'invalid' : date.toISOString();
}
