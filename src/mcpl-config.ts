/**
 * File-driven MCPL server configuration.
 *
 * Reads/writes `mcpl-servers.json` (CC `.mcp.json` shape), keyed by server ID.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { REFUSAL_REACTION_BASELINE } from '@animalabs/agent-framework';
import { namesEnvReference, type RecipeToolLifecycle } from './recipe.js';
import { validateToolLifecycle } from './tool-lifecycle-config.js';

/** Default config file path, resolved from cwd. */
export const DEFAULT_CONFIG_PATH = resolve(process.cwd(), 'mcpl-servers.json');

/**
 * Serializable subset of McplServerConfig (everything except callbacks and scopes).
 */
export interface ServerFileEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Opt in to the full host environment for stdio servers. Requires an
   * agent-framework version with inheritEnv support; prefer explicit env. */
  inheritEnv?: boolean;
  toolPrefix?: string;
  reconnect?: boolean;
  reconnectIntervalMs?: number;
  reconnectMaxIntervalMs?: number;
  enabledFeatureSets?: string[];
  disabledFeatureSets?: string[];
  enabledTools?: string[];
  disabledTools?: string[];
  /** @deprecated One-time migration input for legacy installations. */
  channelSubscription?: 'auto' | 'manual' | string[];
  /**
   * Name of a network access grant (an archipelago audience, e.g.
   * "eidoverse"). Purely declarative here: at load/deploy time the host
   * attaches a credential provider that fetches something fresh on every
   * dial via the identity module. The agent (and this file) never holds a
   * credential — `access` is a name, not a secret.
   */
  access?: string;
  /** MCPL tool lifecycle (RFC-007) policy — see RecipeMcpServer.toolLifecycle. */
  toolLifecycle?: RecipeToolLifecycle;
}

export interface McplServersFile {
  mcplServers: Record<string, ServerFileEntry>;
}

/** A loaded server config — serializable fields plus the id from the key. */
export type LoadedServerConfig = ServerFileEntry & { id: string };

/**
 * Load MCPL server configs from a JSON file.
 * Returns empty array if the file doesn't exist.
 * Resolves relative paths in `args` relative to the config file's directory.
 */
export function loadMcplServers(configPath: string): LoadedServerConfig[] {
  if (!existsSync(configPath)) return [];

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as McplServersFile;
  if (!parsed.mcplServers || typeof parsed.mcplServers !== 'object') return [];

  const configDir = dirname(resolve(configPath));
  const servers: LoadedServerConfig[] = [];

  for (const [id, entry] of Object.entries(parsed.mcplServers)) {
    const args = entry.args?.map(arg => {
      // Resolve relative paths (starting with ./ or ../) relative to config dir
      if (arg.startsWith('./') || arg.startsWith('../')) {
        return resolve(configDir, arg);
      }
      return arg;
    });

    servers.push({
      id,
      command: entry.command,
      args,
      env: entry.env,
      ...(entry.inheritEnv !== undefined
        ? { inheritEnv: checkedInheritEnv(entry.inheritEnv, `mcpl-servers.json: mcplServers.${id}`) }
        : {}),
      toolPrefix: entry.toolPrefix,
      reconnect: entry.reconnect,
      reconnectIntervalMs: entry.reconnectIntervalMs,
      reconnectMaxIntervalMs: entry.reconnectMaxIntervalMs,
      enabledFeatureSets: entry.enabledFeatureSets,
      disabledFeatureSets: entry.disabledFeatureSets,
      enabledTools: entry.enabledTools,
      disabledTools: entry.disabledTools,
      channelSubscription: entry.channelSubscription,
      ...(entry.toolLifecycle !== undefined ? { toolLifecycle: checkedToolLifecycle(entry.toolLifecycle, id) } : {}),
    });
  }

  return servers;
}

function checkedInheritEnv(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${where}.inheritEnv must be a boolean`);
  return value;
}

function checkedToolLifecycle(value: unknown, id: string): RecipeToolLifecycle {
  validateToolLifecycle(value, `mcpl-servers.json: mcplServers.${id}.toolLifecycle`);
  return value as RecipeToolLifecycle;
}

/**
 * Policy fields a recipe may set on a server it takes from mcpl-servers.json
 * by id. The file supplies the spawn command and credentials; the recipe
 * decides how the agent uses the server.
 */
export const RECIPE_OVERRIDABLE_SERVER_FIELDS = [
  'channelSubscription', 'toolPrefix', 'enabledFeatureSets', 'disabledFeatureSets',
  'enabledTools', 'disabledTools', 'reconnect', 'reconnectIntervalMs', 'reconnectMaxIntervalMs',
  'inheritEnv',
  // A recipe may adopt WebSocket transport for a file-defined server.
  'url', 'transport', 'token', 'access',
  // MCPL RFC-007: observation of the agent's other tool calls is per-recipe
  // policy, like tool toggles — not a property of where the server came from.
  'toolLifecycle',
] as const;

/** A file-defined server with the recipe's policy overrides applied. */
export function applyRecipeServerOverrides<T extends Record<string, unknown>>(
  fileEntry: T,
  recipeEntry: Record<string, unknown>,
): T & Record<string, unknown> {
  const merged: Record<string, unknown> = { ...fileEntry };
  for (const field of RECIPE_OVERRIDABLE_SERVER_FIELDS) {
    if (recipeEntry[field] !== undefined) merged[field] = recipeEntry[field];
  }
  return merged as T & Record<string, unknown>;
}

type MergedServer = { id: string; command?: string; url?: string; [k: string]: unknown };

/**
 * The recipe's servers, resolved against mcpl-servers.json. Recipes opt in:
 * a file server loads only when the recipe names its id.
 *
 * - The recipe names a file server (with or without its own command/url):
 *   the file's definition, with the recipe's policy overrides applied.
 * - The recipe defines a server the file doesn't have, with `command` or
 *   `url`: the recipe entry verbatim.
 * - The recipe names an id with neither, and the file has no such server:
 *   an error — a typo'd id must not silently load nothing.
 */
export function mergeRecipeServers(
  recipeServers: Record<string, Record<string, unknown>>,
  fileServers: ReadonlyArray<{ id: string } & Record<string, unknown>>,
): MergedServer[] {
  const fileById = new Map(fileServers.map((s) => [s.id, s]));
  const out: MergedServer[] = [];
  for (const [id, recipeEntry] of Object.entries(recipeServers)) {
    const fileEntry = fileById.get(id);
    if (fileEntry) {
      out.push(applyRecipeServerOverrides(fileEntry, recipeEntry) as MergedServer);
    } else if (recipeEntry.command || recipeEntry.url) {
      out.push({ id, ...recipeEntry } as MergedServer);
    } else {
      throw new Error(
        `Recipe mcpServers.${id} has no "command" or "url", and mcpl-servers.json defines no "${id}" ` +
          `server for it to refer to`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agent overlay — servers the agent deployed/unloaded for itself at runtime
// ---------------------------------------------------------------------------

/** Default agent-owned overlay path, resolved from cwd (per-agent deploy dir). */
export const DEFAULT_AGENT_OVERLAY_PATH = resolve(process.cwd(), 'mcpl-servers.agent.json');

/**
 * An overlay entry is either a full server definition (agent-deployed, loads
 * unconditionally — no recipe opt-in needed) or a tombstone `{disabled: true}`
 * that suppresses a recipe/file server the agent unloaded.
 *
 * Unlike `ServerFileEntry`, `command` is optional here: an entry has EITHER
 * a `command` (stdio) or a `url` (WebSocket), and tombstones have neither.
 */
export interface AgentOverlayEntry extends Partial<ServerFileEntry> {
  /** WebSocket URL (WebSocket transport). Mutually exclusive with command. */
  url?: string;
  transport?: 'stdio' | 'websocket';
  /** Bearer token for WebSocket auth. */
  token?: string;
  /** Tombstone: suppress a recipe/file server the agent unloaded. */
  disabled?: boolean;
}

export interface AgentOverlayFile {
  mcplServers: Record<string, AgentOverlayEntry>;
}

/**
 * Read the agent overlay file: its entries by id, and the root's keys other
 * than `mcplServers`. A missing file, a root without `mcplServers`, and
 * `mcplServers: null` read as no entries, as main read them. The startup
 * warnings name a root that has other keys but no `mcplServers`, since a
 * misspelled key would otherwise drop the agent's tombstones without a word.
 *
 * A file that can't be parsed, a root that isn't an object, or an
 * `mcplServers` that isn't a map of entries by id throws an error naming the
 * file, rather than any one entry being skipped: the file carries the
 * agent's tombstones, so reading past it would load servers the agent
 * unloaded. The boot stops with that error until the file is fixed (Nell-1783's
 * haiku probe of #228). No writer produces those shapes; saveAgentOverlay
 * always writes `{ "mcplServers": { … } }`. The error never quotes the file,
 * which can hold credentials.
 */
export function readAgentOverlayFile(overlayPath: string): { servers: Record<string, AgentOverlayEntry>; otherKeys: string[] } {
  if (!existsSync(overlayPath)) return { servers: {}, otherKeys: [] };
  const raw = readFileSync(overlayPath, 'utf-8');
  const fixIt = 'fix it: moving it aside would load every server the agent unloaded and drop its deployments';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`the agent overlay ${overlayPath} isn't valid JSON: ${fixIt}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`the agent overlay ${overlayPath} isn't an object with mcplServers: ${fixIt}`);
  }
  const otherKeys = Object.keys(parsed).filter((k) => k !== 'mcplServers');
  const servers = (parsed as { mcplServers?: unknown }).mcplServers;
  if (servers === undefined || servers === null) return { servers: {}, otherKeys };
  if (typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`the agent overlay ${overlayPath} has an mcplServers that isn't a map of entries by id: ${fixIt}`);
  }
  return { servers: servers as Record<string, AgentOverlayEntry>, otherKeys };
}

/** The agent overlay's entries by id (readAgentOverlayFile). */
export function readAgentOverlay(overlayPath: string): Record<string, AgentOverlayEntry> {
  return readAgentOverlayFile(overlayPath).servers;
}

/** Name lists, where one name given as a string reads as a list of one. */
const OVERLAY_NAME_LIST_FIELDS = [
  'enabledFeatureSets',
  'disabledFeatureSets',
  'enabledTools',
  'disabledTools',
  'disabledCapabilities',
] as const;

/** An overlay entry as the boot reads it: well formed, with `notes` on what
 *  was read differently from how it's written; or why it's malformed. */
export type OverlayEntryReading =
  | { entry: AgentOverlayEntry; notes: string[]; problem?: undefined }
  | { problem: string; entry?: undefined; notes?: undefined };

/**
 * Read one agent overlay entry as the boot reads it. Every reader takes this
 * reading (the boot, the startup warnings, mcpl_list, mcpl_restart's note,
 * mcpl_unload), so they agree on what the boot loaded, and none throws on a
 * shape.
 *
 * The overlay is the agent's hand-editable file, and main loaded more shapes
 * than a strict reading would. A shape main loaded loads the same way, so a
 * file that worked keeps working (the review of #228, sw-ch228):
 * - `disabled: true` is a tombstone, whatever else the entry holds: the
 *   agent's unload wins;
 * - `null` in a field reads as the field absent;
 * - a `transport` other than stdio or websocket reads as absent, as the
 *   framework reads it (isWebSocketTransport);
 * - an env value that isn't text, a number or true/false passes on as its
 *   text, as main passed it, and an empty list as env (strict function
 *   calling's "unspecified") reads as no env;
 * - a number `toolPrefix` reads as its text, and a name list given as one
 *   string reads as a list of one, which main iterated character by character.
 * Each such reading is named in `notes`, which the startup warnings log.
 *
 * Malformed, so the boot skips it and the operator's definition, if any,
 * stays: an entry that isn't an object; `disabled` that's neither true nor
 * false; `command`, `url`, `token` or `access` that isn't text; `args` that
 * aren't a list of text, numbers or true/false (main threw on those); an env
 * or name list of the wrong kind; or an entry for which the framework would
 * open nothing: websocket without a url, stdio without a command, or neither.
 *
 * `strict` is for new writes (mcpl_deploy): what a model writes now is held
 * to the plain shapes, so an env value that isn't text, a number or
 * true/false, a transport other than stdio or websocket, and a `toolPrefix`
 * that isn't text are refused rather than read leniently.
 */
export function readOverlayEntry(raw: unknown, opts: { strict?: boolean } = {}): OverlayEntryReading {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'it isn\'t an object' };
  const e: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (e.disabled === true) return { entry: { disabled: true }, notes: [] };
  if (e.disabled !== undefined && e.disabled !== null && e.disabled !== false) {
    return { problem: 'its disabled is neither true nor false' };
  }
  delete e.disabled;
  for (const k of Object.keys(e)) if (e[k] === null) delete e[k];
  const notes: string[] = [];
  const plain = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  for (const k of ['command', 'url', 'token', 'access']) {
    if (e[k] !== undefined && typeof e[k] !== 'string') return { problem: `its ${k} isn't text` };
  }
  if (e.toolPrefix !== undefined && typeof e.toolPrefix !== 'string') {
    if (opts.strict || typeof e.toolPrefix !== 'number') return { problem: 'its toolPrefix isn\'t text' };
    e.toolPrefix = String(e.toolPrefix);
    notes.push(`its toolPrefix ${e.toolPrefix} is a number, read as its text`);
  }
  if (e.transport !== undefined && e.transport !== 'stdio' && e.transport !== 'websocket') {
    if (opts.strict) return { problem: 'its transport is neither stdio nor websocket' };
    notes.push(`its transport ${JSON.stringify(e.transport)} is neither stdio nor websocket, so it's read as absent, as the framework reads it`);
    delete e.transport;
  }
  if (e.args !== undefined) {
    if (!Array.isArray(e.args) || !e.args.every(plain)) return { problem: 'its args aren\'t a list of text, numbers or true/false' };
    e.args = e.args.map(String);
  }
  if (e.env !== undefined) {
    if (Array.isArray(e.env) && e.env.length === 0) {
      delete e.env;
    } else if (typeof e.env !== 'object' || Array.isArray(e.env)) {
      return { problem: 'its env isn\'t a map of names to values' };
    } else {
      const odd = Object.entries(e.env as Record<string, unknown>).filter(([, v]) => !plain(v)).map(([k]) => k);
      if (odd.length > 0) {
        if (opts.strict) return { problem: `its env ${odd.join(', ')} ${odd.length === 1 ? 'isn\'t' : 'aren\'t'} text, a number or true/false` };
        notes.push(`its env ${odd.join(', ')} ${odd.length === 1 ? 'isn\'t' : 'aren\'t'} text, a number or true/false, and pass${odd.length === 1 ? 'es' : ''} on as text, as before`);
      }
      e.env = Object.fromEntries(Object.entries(e.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    }
  }
  for (const k of OVERLAY_NAME_LIST_FIELDS) {
    if (e[k] === undefined) continue;
    if (typeof e[k] === 'string') {
      e[k] = [e[k]];
      notes.push(`its ${k} is one name, read as a list of one`);
    } else if (!Array.isArray(e[k]) || !(e[k] as unknown[]).every((x) => typeof x === 'string')) {
      return { problem: `its ${k} isn't a list of names` };
    }
  }
  if (e.transport === 'websocket' && !e.url) return { problem: 'its transport is websocket, but it has no url' };
  if (e.transport === 'stdio' && !e.command) return { problem: 'its transport is stdio, but it has no command' };
  if (!e.command && !e.url) return { problem: 'it names nothing to run or dial' };
  return { entry: e as AgentOverlayEntry, notes };
}

/** Why an agent overlay entry is malformed, or null when it's read (readOverlayEntry). */
export function overlayEntryProblem(entry: unknown, opts: { strict?: boolean } = {}): string | null {
  return readOverlayEntry(entry, opts).problem ?? null;
}

/** A tombstone: `disabled: true`, the one rule every reader uses, whatever else the entry holds. */
export function overlayEntryTombstones(entry: unknown): boolean {
  return readOverlayEntry(entry).entry?.disabled === true;
}

/** Write the agent overlay file. */
export function saveAgentOverlay(
  overlayPath: string,
  servers: Record<string, AgentOverlayEntry>,
): void {
  const data: AgentOverlayFile = { mcplServers: servers };
  // Written whole or not at all: a crash mid-write would leave a truncated
  // file, which stops the next boot (readAgentOverlayFile).
  const tmp = `${overlayPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, overlayPath);
}

/**
 * Capabilities an agent-deployed server is never granted by default: the
 * consequential surfaces — context hooks (observation of and injection into
 * the agent's own inference), server-initiated inference, and inference
 * lifecycle. Bare parents on purpose: the config mask's subtree matching
 * denies everything beneath them, present and future (afterInference, undo,
 * state land under these the day the vocabulary grows them). A world/chat
 * server needs none of this — channels + tools is the whole job. An operator
 * who wants a self-deployed server to hold one of these moves the server
 * into the recipe, where `enabledCapabilities` is theirs to write.
 */
export const AGENT_DEPLOY_DENIED_CAPABILITIES: readonly string[] = [
  'contextHooks',
  'inferenceRequest',
  'inferenceLifecycle',
  // MCPL RFC-007: observing the agent's OTHER tool calls (and their
  // arguments) is an operator grant. The bare parent masks both leaves, so a
  // toolLifecycle block the agent writes cannot re-grant them either.
  'toolLifecycle',
];

/** The allow/deny list fields where an EMPTY array carries no intent (see
 *  resolveOverlayEntry — OpenAI strict function calling forces every schema
 *  property, so agent tool calls arrive with `[]` meaning "unspecified"). */
const OVERLAY_LIST_FIELDS = [
  'enabledFeatureSets',
  'disabledFeatureSets',
  'enabledTools',
  'disabledTools',
] as const;

/**
 * Resolve an overlay entry into a server config object (id + fields, relative
 * `./`/`../` args resolved against the overlay file's directory). Returns
 * null for tombstones and entries with neither command nor url.
 *
 * The overlay is the AGENT's file, so resolution is also where host policy
 * for self-deployed servers lives (applied at boot AND at deploy — existing
 * files heal without a re-deploy):
 *
 *  - Empty allow/deny lists are treated as absent. OpenAI-style strict
 *    function calling forces every schema property, so GPT-family residents
 *    calling mcpl_deploy emit `[]` where they meant "unspecified" — and for
 *    enabledFeatureSets PRESENT-empty is deny-all under the §5.3 pin (Mica's
 *    silently eventless eidoverse, 2026-08-04). (agent-framework already
 *    reads `enabledTools: []` as "all tools".) Deny-all for tools is
 *    `disabledTools: ["*"]`: tool patterns are whole-name globs, `*` = any
 *    run. Feature-set patterns are not: `*` stands for exactly one
 *    dot-separated segment, and a pattern only matches names with as many
 *    segments, so `disabledFeatureSets: ["*"]` denies `channels` but not
 *    `memory.retrieval`. No single pattern denies every set; list one per
 *    depth (`["*", "*.*", "*.*.*"]` covers names of up to three segments).
 *
 *  - `inheritEnv` is dropped: full host-environment inheritance is granted
 *    only by operator-owned recipe/file configuration, never an overlay.
 *
 *  - `enabledCapabilities` is dropped: the agent's file can narrow, never
 *    widen — a hand-written entry here could re-grant §13.4 deny-by-default
 *    paths.
 *
 *  - `disabledCapabilities` always carries at least
 *    AGENT_DEPLOY_DENIED_CAPABILITIES (unioned with anything the entry
 *    already denies): self-deployed servers get channels + tools and
 *    nothing consequential by default.
 *
 *  - A string `access` is trimmed, as mcpl_deploy writes it. A grant is a
 *    name, and the boot asks for the grant as resolved here (index.ts), so
 *    a hand-edited name is the grant the startup warnings compare
 *    (lostByReplacement).
 */
export function resolveOverlayEntry(
  id: string,
  entry: AgentOverlayEntry,
  overlayPath: string,
): ({ id: string; command?: string; url?: string } & Record<string, unknown>) | null {
  const read = readOverlayEntry(entry).entry;
  if (!read || read.disabled === true) return null;
  const overlayDir = dirname(resolve(overlayPath));
  const { disabled: _d, ...fields } = read;
  const rec = fields as Record<string, unknown>;
  for (const k of OVERLAY_LIST_FIELDS) {
    if (Array.isArray(rec[k]) && (rec[k] as unknown[]).length === 0) delete rec[k];
  }
  delete rec.enabledCapabilities;
  // Args and env values arrive as text already (readOverlayEntry).
  // Same boundary for MCPL tool lifecycle: in the framework a toolLifecycle
  // block IS the grant, so the agent's own file never carries one (the deny
  // above already masks the paths; this keeps the overlay honest too).
  delete rec.toolLifecycle;
  // Full host environment access is an operator grant, not an agent-owned
  // overlay setting. Operators declare it in the recipe or mcpl-servers.json.
  delete rec.inheritEnv;
  // The grant the boot dials is the grant the warnings compare.
  if (typeof rec.access === 'string') rec.access = rec.access.trim();
  // A network server the agent deployed should come back when it bounces.
  // reconnect defaulted to false, so an entry that never said `reconnect:
  // true` was severed PERMANENTLY by any server restart — with no signal to
  // anyone — until the agent's own next restart, which for a long-lived
  // resident is days away (Mythos, eventless in eidoverse after the
  // 2026-08-04 door deploy). Websocket entries now default to reconnect
  // unless the entry explicitly says false. Stdio entries keep the old
  // default: reconnect does not respawn a dead child anyway (mcpl_restart
  // is that path), so `true` there would promise something it can't do.
  // By the connection the framework opens (dialsUrl), not by a url's
  // presence: a spawned entry that also names a url would otherwise be
  // respawned on exit.
  if (dialsUrl(read) && rec.reconnect === undefined) rec.reconnect = true;
  const denied = new Set<string>([
    ...AGENT_DEPLOY_DENIED_CAPABILITIES,
    ...(Array.isArray(rec.disabledCapabilities) ? (rec.disabledCapabilities as unknown[]).map(String) : []),
  ]);
  return {
    id,
    ...rec,
    disabledCapabilities: [...denied].sort(),
    ...(Array.isArray(rec.args)
      ? {
          args: (rec.args as string[]).map(arg =>
            arg.startsWith('./') || arg.startsWith('../') ? resolve(overlayDir, arg) : arg,
          ),
        }
      : {}),
  };
}

/**
 * Apply the agent overlay to a resolved server list:
 *   - tombstones (`disabled: true`) remove the matching server
 *   - full entries replace an existing server or append a new one
 * Relative `./`/`../` args are resolved against the overlay file's directory.
 */
export function applyAgentOverlay<T extends { id: string }>(
  servers: T[],
  overlayPath: string,
): Array<T | ({ id: string } & Record<string, unknown>)> {
  const overlay = readAgentOverlay(overlayPath);
  if (Object.keys(overlay).length === 0) return servers;

  // A malformed entry is skipped: neither a tombstone nor a replacement.
  const result: Array<T | ({ id: string } & Record<string, unknown>)> =
    servers.filter(s => !overlayEntryTombstones(overlay[s.id]));

  for (const [id, entry] of Object.entries(overlay)) {
    const loaded = resolveOverlayEntry(id, entry, overlayPath);
    if (!loaded) continue;
    const idx = result.findIndex(s => s.id === id);
    if (idx >= 0) result[idx] = loaded;
    else result.push(loaded);
  }

  return result;
}

/**
 * What a server definition gives its process or connection, by name only:
 * the env names it maps, and not their values, which are credentials;
 * whether it carries a token; the access grant it names; and whether it
 * inherits the host environment.
 */
export interface ServerProvisions {
  env: string[];
  token: boolean;
  access: string | null;
  inheritEnv: boolean;
}

export function serverProvisions(definition: Record<string, unknown>): ServerProvisions {
  const env = definition.env && typeof definition.env === 'object' ? Object.keys(definition.env) : [];
  // As the boot dials it: the operator's grant isn't trimmed, so a grant
  // that differs only by spaces is another audience, and the comparison
  // (lostByReplacement) says so.
  const access = typeof definition.access === 'string' ? definition.access : '';
  return {
    env: env.sort(),
    token: typeof definition.token === 'string' && definition.token !== '',
    access: access || null,
    inheritEnv: definition.inheritEnv === true,
  };
}

/** A text that names a host variable, as substituteEnvVars reads one. */
const namesHostVariable = (text: unknown): boolean => typeof text === 'string' && namesEnvReference(text);

/** An overlay entry's env when it's a map, else none. The overlay is the
 *  agent's hand-editable file, so the readers here take its shapes as they
 *  come and never throw on one: the startup warnings mustn't become a new
 *  way for a malformed entry to stop a start. */
const envOf = (entry: AgentOverlayEntry): Record<string, unknown> =>
  entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) ? entry.env : {};

/** Whether agent-framework dials an entry's URL rather than spawning its
 *  command. This is its isWebSocketTransport (mcpl/transport.ts), which the
 *  package doesn't export: an explicit `transport` decides, and otherwise a
 *  `url` with no `command`. The readers here choose their branch by it, so
 *  what they name is what the connection the framework opens would carry. */
export const dialsUrl = (entry: { transport?: unknown; url?: unknown; command?: unknown }): boolean =>
  entry.transport === 'websocket' || (entry.transport !== 'stdio' && Boolean(entry.url) && !entry.command);

/**
 * The parts of an agent overlay entry that name a host variable (`${VAR}`),
 * as labels for a receipt: `command`, `args` and `env NAME` for an entry the
 * framework spawns, `url`, `token` and `access` for one it dials (dialsUrl).
 * Only a recipe substitutes those (substituteEnvVars); from an overlay entry
 * the server gets the text as written. Labels only, never values. The entry
 * is read as the boot reads it (readOverlayEntry); a malformed one names none.
 */
export function hostVariableReferences(raw: AgentOverlayEntry): string[] {
  const refs: string[] = [];
  const entry = readOverlayEntry(raw).entry;
  if (!entry) return refs;
  if (entry.command && !dialsUrl(entry)) {
    if (namesHostVariable(entry.command)) refs.push('command');
    if (Array.isArray(entry.args) && entry.args.some(namesHostVariable)) refs.push('args');
    const env = envOf(entry);
    for (const name of Object.keys(env).sort()) {
      // The host sets this one over the entry's value, so the server never
      // gets the entry's text for it (as lostByReplacement reads it).
      if (namesHostVariable(env[name]) && !hostSetsOverServer(name)) refs.push(`env ${name}`);
    }
  } else if (dialsUrl(entry) && entry.url) {
    if (namesHostVariable(entry.url)) refs.push('url');
    if (namesHostVariable(entry.token)) refs.push('token');
    if (namesHostVariable(entry.access)) refs.push('access');
  }
  return refs;
}

/**
 * What an agent overlay entry that replaces an operator's definition lacks
 * of it, as a phrase for a receipt or a log line, or null when it lacks
 * nothing that would reach it.
 *
 * The replacement is whole (applyAgentOverlay). Its text is literal, since
 * `${VAR}` substitution is the recipe's, and it never inherits the host
 * environment, since resolveOverlayEntry drops `inheritEnv`. So the
 * operator's value for a name the entry doesn't declare never reaches the
 * server: agent-framework gives a stdio child its declared env, and for a
 * short allowlist (PATH, HOME, locale, proxies and the like) the host's own
 * values. A server that needs the operator's value starts without it, and
 * can look healthy until its first call: on 2026-10-08 a resident's shell
 * came back from `mcpl_restart` without the SESSION_SERVER_TOKEN its daemon
 * wanted, and the restart reported success. A value that names a host
 * variable supplies nothing (hostVariableReferences), so its name counts as
 * lacking. A name the host sets over any server's mapping
 * (hostSetsOverServer) can't be lacking: no definition's value for it
 * reaches a child.
 *
 * Env and inheritance count only for a replacement that spawns a process; a
 * token and an access grant count only for one that dials a URL, as the
 * framework chooses between them (dialsUrl).
 */
export function lostByReplacement(operator: ServerProvisions, raw: AgentOverlayEntry): string | null {
  const lost: string[] = [];
  const entry = readOverlayEntry(raw).entry;
  if (!entry || entry.disabled === true) return null;
  if (entry.command && !dialsUrl(entry)) {
    const declared = new Set(
      Object.entries(envOf(entry)).filter(([, value]) => !namesHostVariable(value)).map(([name]) => name),
    );
    const missing = operator.env.filter((name) => !declared.has(name) && !hostSetsOverServer(name));
    if (missing.length > 0) lost.push(`env ${missing.join(', ')}`);
    if (operator.inheritEnv) lost.push('inherited host environment (inheritEnv)');
  } else if (dialsUrl(entry) && entry.url) {
    const token = typeof entry.token === 'string' && entry.token !== '' && !namesHostVariable(entry.token);
    if (operator.token && !token) lost.push('token');
    // A grant is a name, not a credential: another name is another grant.
    // Each side as it's dialled: the replacement's trimmed, as
    // resolveOverlayEntry resolves it, the operator's as written.
    const access = typeof entry.access === 'string' ? entry.access.trim() : '';
    if (operator.access && access !== operator.access) lost.push(`access grant "${operator.access}"`);
  }
  return lost.length > 0 ? lost.join('; ') : null;
}

/** Whether the host sets `name` on every stdio child over whatever a server
 *  maps for it (composeMcplChildEnv, AGENT_TIMEZONE today), so no
 *  definition's own value reaches a child and a replacement can't lack it.
 *  Read from the composition itself, so the two can't drift. */
function hostSetsOverServer(name: string): boolean {
  const mapped = '\u0000mapped';
  return composeMcplChildEnv({ [name]: mapped }, '')[name] !== mapped;
}

/** Whether an overlay entry replaces a server rather than tombstoning it or
 *  being skipped: the entries applyAgentOverlay puts in a server's place. A
 *  malformed one (overlayEntryProblem) never does. */
export function overlayEntryReplaces(entry: unknown): entry is AgentOverlayEntry {
  const read = entry === undefined ? undefined : readOverlayEntry(entry).entry;
  return read !== undefined && read.disabled !== true;
}

/**
 * The startup log's lines about the agent overlay: one for each entry that
 * replaces an operator's definition and lacks something of it
 * (lostByReplacement), and one for each entry with a part that names a host
 * variable (hostVariableReferences). An operator reading the log learns why
 * a server misbehaves before anyone calls it.
 */
export function overlayWarnings(
  operatorServers: ReadonlyArray<{ id: string } & Record<string, unknown>>,
  overlayPath: string,
): string[] {
  const operatorById = new Map(operatorServers.map((server) => [server.id, server]));
  const lines: string[] = [];
  const { servers, otherKeys } = readAgentOverlayFile(overlayPath);
  if (Object.keys(servers).length === 0 && otherKeys.length > 0) {
    lines.push(
      `[mcpl] the agent overlay (${overlayPath}) has no mcplServers, only ${otherKeys.map((k) => JSON.stringify(k)).join(', ')}, ` +
      'so it holds no entries and no tombstones: a misspelled key would drop the agent\'s tombstones',
    );
  }
  for (const [id, entry] of Object.entries(servers)) {
    const reading = readOverlayEntry(entry);
    if (reading.problem !== undefined) {
      lines.push(
        `[mcpl] server "${id}": the agent overlay (${overlayPath}) entry is malformed (${reading.problem}), so the boot skips it` +
        (operatorById.has(id) ? ' and the operator\'s definition loads' : ''),
      );
      continue;
    }
    for (const note of reading.notes) {
      lines.push(`[mcpl] server "${id}": the agent overlay (${overlayPath}) entry loads, but ${note}`);
    }
    if (!overlayEntryReplaces(entry)) continue;
    const operator = operatorById.get(id);
    const lost = operator ? lostByReplacement(serverProvisions(operator), entry) : null;
    if (lost) {
      lines.push(
        `[mcpl] server "${id}": the agent overlay (${overlayPath}) replaces the operator's definition ` +
        `and lacks its ${lost}, so the server runs without the operator's values for them`,
      );
    }
    const refs = hostVariableReferences(entry);
    if (refs.length > 0) {
      lines.push(
        `[mcpl] server "${id}": the agent overlay (${overlayPath}) names a host variable in its ` +
        `${refs.join(', ')}, which only a recipe substitutes, so the server gets that text as written`,
      );
    }
  }
  return lines;
}

/**
 * Read the raw server entries from the config file (for editing).
 * Returns empty object if file doesn't exist.
 */
export function readMcplServersFile(configPath: string): Record<string, ServerFileEntry> {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as McplServersFile;
  return parsed.mcplServers ?? {};
}

/**
 * Write server entries to the config file.
 */
export function saveMcplServers(configPath: string, servers: Record<string, ServerFileEntry>): void {
  const data: McplServersFile = { mcplServers: servers };
  writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Compose the environment for a stdio MCPL child.
 *
 * Two host-owned values ride along with whatever the server entry declares:
 *
 * - `DISCORD_SUPPRESSED_REACTIONS_BASELINE` — the framework's exported
 *   refusal-annotation set (REFUSAL_REACTION_BASELINE, comma-joined), so a
 *   never-configured Discord adapter defaults to suppressing exactly the
 *   markers this host's framework stamps. Placed BEFORE the spread: an
 *   operator who sets the var on the server entry supersedes the house
 *   baseline — the host injects a default, never overrides a decision. The
 *   adapter's own precedence (file key incl. [] → legacy operator env →
 *   baseline) then decides what is actually enforced; house markers are
 *   Host semantics, and a standalone adapter without this composition stays
 *   honestly unprotected.
 * - `AGENT_TIMEZONE` — after the spread, deliberately: the agent-facing
 *   wall clock is resolved per-recipe by the host and is not a per-server
 *   operator knob.
 */
export function composeMcplChildEnv(
  serverEnv: Record<string, string> | undefined,
  timeZone: string,
): Record<string, string> {
  return {
    DISCORD_SUPPRESSED_REACTIONS_BASELINE: REFUSAL_REACTION_BASELINE.join(','),
    ...(serverEnv ?? {}),
    AGENT_TIMEZONE: timeZone,
  };
}
