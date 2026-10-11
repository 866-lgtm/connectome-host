/**
 * `/bug <text>`: a report someone in trouble can send us in one step, with
 * nothing in it they didn't mean to share.
 *
 * Reports go to connectome-host's public issues, so a report must not be
 * able to carry conversation text at all. The rule that gives that:
 * **nothing a session wrote, and nothing a user chose, goes in, except the
 * text the user wrote for the report.** Every other line is built from a
 * field with a known shape, read through an allowlist:
 * - versions, the commit, the runtime and the mode;
 * - the setup as structure: the provider, a model id only when it matches
 *   the provider's public id pattern, our built-in modules by name, budget
 *   numbers, and each MCP server by ordinal with its kind, transport,
 *   family and state;
 * - provider failures as classifications (time, status, membrane error
 *   type, retryable, a known provider code);
 * - host errors as shapes: how often each happened, a known class name, and
 *   where in our own code it was thrown, as package-relative `path:line`.
 *
 * No log line, error message, request, response, prompt, server name,
 * command, argument, url, env value or path is copied, and that holds for
 * the local file too. The error logs can't be cleaned of conversation text
 * reliably (they hold all of stderr, a server's included, and a provider can
 * echo a whole request in its error), so they are read only for shapes.
 *
 * Nothing is sent from here. The command shows the report, writes it to a
 * file, and gives a link to GitHub's new-issue form, filled in; the user
 * reads it there and submits it themselves, so no credentials are needed.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Where reports go, and what they're called
// ---------------------------------------------------------------------------

/** The one destination: connectome-host's public issues. */
export const BUG_REPORT_REPO = 'anima-research/connectome-host';
/** The issue form the link fills (.github/ISSUE_TEMPLATE/bug_report.yml). */
export const BUG_REPORT_TEMPLATE = 'bug_report.yml';
/** The report's first line: what made it and in which format. */
export const BUG_REPORT_MARKER = 'connectome-host /bug v1';
/** Prefilled links much longer than this risk GitHub's 414. */
export const BUG_REPORT_URL_CAP = 6_000;
/** What the issue title takes of the user's first line. */
const TITLE_CHARS = 80;

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

const PROVIDERS = new Set(['anthropic', 'openai-responses', 'openai-codex', 'openrouter', 'bedrock', 'openai-compatible', 'mock']);

/** A model id goes in only when it reads as a public id of its provider; a
 *  fine-tune's or a custom endpoint's name is the user's choice of words,
 *  and a Bedrock ARN holds an account number. */
const PUBLIC_MODEL_ID: Record<string, RegExp> = {
  anthropic: /^claude-[a-z0-9][a-z0-9.-]{0,60}$/,
  bedrock: /^(?:(?:us|eu|apac|global)\.)?anthropic\.claude-[a-z0-9][a-z0-9.:-]{0,70}$/,
  'openai-responses': /^(?:gpt|o[0-9]|chatgpt|codex)[a-z0-9.-]{0,60}$/,
  'openai-codex': /^(?:gpt|o[0-9]|codex)[a-z0-9.-]{0,60}$/,
  openrouter: /^[a-z0-9][a-z0-9.-]{0,40}\/[a-z0-9][a-z0-9.:-]{0,60}$/,
};

/** Our built-in modules (RecipeModules' keys). Anything else is counted. */
const BUILT_IN_MODULES = [
  'subagents', 'lessons', 'retrieval', 'wake', 'workspace', 'instructions', 'activity', 'notices',
  'mcplAdmin', 'history', 'identity', 'fleet', 'webui', 'ttsRelay', 'subscriptionGc', 'channelMode',
];

const FORMATTERS = new Set(['native', 'anthropic-xml']);
const PROSE_ROUTING = new Set(['locus', 'explicit', 'hybrid', 'disabled']);
const CACHE_TTLS = new Set(['5m', '1h']);

/** Membrane's error types (MembraneErrorType). */
const MEMBRANE_ERROR_TYPES = new Set([
  'rate_limit', 'context_length', 'invalid_request', 'auth', 'server', 'network', 'timeout', 'abort',
  'safety', 'unsupported', 'unknown',
]);

/** Provider error codes as their APIs document them. Any other code is
 *  "other": a code is the provider's string, and can be anything. */
const PROVIDER_ERROR_CODES = new Set([
  // Anthropic
  'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large',
  'rate_limit_error', 'api_error', 'overloaded_error', 'billing_error', 'timeout_error',
  // OpenAI
  'rate_limit_exceeded', 'insufficient_quota', 'context_length_exceeded', 'invalid_api_key', 'model_not_found',
  'server_error', 'content_filter',
  // Bedrock
  'ThrottlingException', 'ValidationException', 'ServiceUnavailableException', 'ModelTimeoutException',
  'AccessDeniedException', 'ModelNotReadyException', 'ModelErrorException', 'InternalServerException',
  'ResourceNotFoundException', 'ServiceQuotaExceededException', 'ModelStreamErrorException',
]);

/** The error classes a report names; any other is "another error class". */
const ERROR_CLASSES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError',
  'MembraneError', 'McplRequestError', 'McplProtocolVersionError', 'McplUnreapedLaunchError',
  'McplResponseSerializationError', 'CoalesceError', 'OverBudgetError', 'DiscordAwarenessAccountingError',
  'HandshakeCleanupError', 'AbortError', 'TimeoutError',
]);

/**
 * The bracketed tags our own code starts a log line with (connectome-host,
 * agent-framework, membrane, context-manager). An MCP server's stderr lands
 * in the same log and can start with any bracketed text, so only these are
 * named; every other tag is counted as "other".
 */
export const HOST_LOG_TAGS = new Set([
  'agent-settings', 'anthropic-credentials', 'autobiographical', 'budget-preflight', 'channel', 'cm-cache',
  'coalescing', 'compression-quarantine', 'context-maintenance', 'credential', 'credential-monitor', 'deprecated',
  'diagnostics', 'discord', 'discord-awareness', 'estimator-calibration', 'fleet', 'framework', 'gate',
  'gate-telemetry', 'heartbeat', 'host-command', 'host-mode', 'identity',
  'inference-dropped', 'inference-failed', 'inference-hard-down', 'inference-refusal', 'inference-rewind',
  'inference-stale', 'kv-continuity-relaxation', 'kv-diag', 'kv-escalation', 'kv-overlap', 'kv-timing',
  'kv-unified', 'liveness-watchdog', 'llm-calls', 'mcp', 'mcpl', 'membrane', 'membrane-oversize',
  'membrane:bedrock', 'membrane:content', 'membrane:cost', 'membrane:gemini', 'membrane:normalize-tool-pairs',
  'membrane:openrouter', 'membrane:usage', 'merge-quarantine', 'merge-topology', 'message-store',
  'mint-preimage', 'notices', 'nudge', 'openai-codex', 'operator', 'operator-log', 'ops-alert',
  'picker-config-drift', 'picker-dead-ids', 'picker-unrealizable', 'prose', 'provider-admission',
  'provider-cooldown', 'puppet', 'push-event-rejected', 'reasoning', 'reasoning-effort', 'refusal-retry',
  'refusal-rewind', 'rfc005',
  'routespeech', 'routing', 'self-wake', 'settings', 'shutdown', 'sleep', 'spill', 'store-topology',
  'subagent', 'tool', 'tool-boundary', 'tool-result-guard', 'tts-relay', 'unstick', 'webui',
  'webui-observers', 'windowed-passthrough', 'workspace',
]);

/** The dependencies whose frames a report names (under node_modules/@animalabs). */
const OUR_PACKAGES = ['agent-framework', 'membrane', 'context-manager', 'mcpl-core', 'chronicle'];

// ---------------------------------------------------------------------------
// What a report is made of
// ---------------------------------------------------------------------------

export type RuntimeMode = 'tui' | 'headless' | 'readline' | 'batch';

export interface BugReportFacts {
  now: Date;
  mode: RuntimeMode;
  host: { version: string | null; commit: { sha: string; modified: boolean | null } | null };
  packages: Array<{ name: string; version: string | null }>;
  runtime: { os: string; release: string | null; arch: string; bun: string | null; node: string | null };
  setup: {
    provider: string | null;
    model: string | null;
    formatter: string | null;
    maxTokens: number | null;
    contextBudgetTokens: number | null;
    cacheTtl: string | null;
    proseRouting: string | null;
    thinking: boolean | null;
    modules: string[];
    customModules: number;
  };
  servers: ServerRow[];
  /** Null when this process keeps no provider-call log. */
  providerCalls: ProviderCallSummary | null;
  /** Null when this mode keeps no error log (readline and batch print to the terminal). */
  hostErrors: HostErrorSummary | null;
}

export interface ServerRow {
  kind: string;
  transport: 'stdio' | 'websocket' | 'unknown';
  family: 'legacy' | 'modern';
  connected: boolean;
  retrying: boolean;
  refused: boolean;
  toolCount: number;
}

export interface ProviderFailure {
  at: string;
  kind: 'complete' | 'stream' | null;
  provider: string | null;
  status: number | null;
  type: string | null;
  retryable: boolean | null;
  code: string | null;
}

export interface ProviderCallSummary {
  calls: number;
  failed: number;
  recent: ProviderFailure[];
}

export interface HostErrorShape {
  className: string;
  frames: string[];
  count: number;
  signature: string;
}

export interface HostErrorSummary {
  log: 'tui-error.log' | 'headless.log';
  tags: Array<[string, number]>;
  otherTags: number;
  errors: HostErrorShape[];
}

// ---------------------------------------------------------------------------
// Reading values through the allowlists
// ---------------------------------------------------------------------------

const VERSION = /^[0-9][0-9A-Za-z.+-]{0,40}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function version(value: unknown): string | null {
  return typeof value === 'string' && VERSION.test(value) ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The provider's model id when it reads as a public one, else `custom`. */
export function publicModelId(provider: string | null, model: unknown): string | null {
  if (typeof model !== 'string' || model === '') return null;
  const pattern = provider ? PUBLIC_MODEL_ID[provider] : undefined;
  return pattern && pattern.test(model) ? model : 'custom';
}

// ---------------------------------------------------------------------------
// The setup, from the recipe and the live servers
// ---------------------------------------------------------------------------

interface RecipeLike {
  agent?: {
    provider?: unknown; model?: unknown; formatter?: unknown; maxTokens?: unknown; contextBudgetTokens?: unknown;
    cacheTtl?: unknown; proseRouting?: unknown; thinking?: unknown;
  };
  modules?: object;
  extensions?: object;
}

export interface ServerConfigLike {
  command?: unknown;
  url?: unknown;
  transport?: unknown;
  protocol?: unknown;
  source?: { npm?: unknown; url?: unknown };
}

/** A live server, as `listMcplServers()` gives it (fields read on their own). */
export interface LiveServerLike {
  id: string;
  connected?: unknown;
  retrying?: unknown;
  toolCount?: unknown;
  refused?: unknown;
}

const OUR_PACKAGE_SPEC = /^@animalabs\/[a-z0-9][a-z0-9-]{0,60}@[0-9][0-9A-Za-z.+-]{0,40}$/;

export function setupFacts(recipe: RecipeLike): BugReportFacts['setup'] {
  const agent = recipe.agent ?? {};
  const provider = typeof agent.provider === 'string' && PROVIDERS.has(agent.provider)
    ? agent.provider
    : agent.provider === undefined ? 'anthropic' : 'other';
  const modules = (recipe.modules ?? {}) as Record<string, unknown>;
  const enabled = (value: unknown): boolean => value !== undefined && value !== false && value !== null;
  const thinking = agent.thinking && typeof agent.thinking === 'object'
    ? (agent.thinking as { enabled?: unknown }).enabled === true
    : null;
  return {
    provider,
    model: publicModelId(provider, agent.model),
    formatter: typeof agent.formatter === 'string' && FORMATTERS.has(agent.formatter) ? agent.formatter : null,
    maxTokens: count(agent.maxTokens),
    contextBudgetTokens: count(agent.contextBudgetTokens),
    cacheTtl: typeof agent.cacheTtl === 'string' && CACHE_TTLS.has(agent.cacheTtl) ? agent.cacheTtl : null,
    proseRouting: typeof agent.proseRouting === 'string' && PROSE_ROUTING.has(agent.proseRouting) ? agent.proseRouting : null,
    thinking,
    modules: BUILT_IN_MODULES.filter((name) => Object.hasOwn(modules, name) && enabled(modules[name])),
    customModules: Object.keys(recipe.extensions ?? {}).length
      + Object.keys(modules).filter((name) => !BUILT_IN_MODULES.includes(name) && enabled(modules[name])).length,
  };
}

/** Each live server by ordinal: no id, command, argument or url, since a
 *  name the user chose can say what they're doing. */
export function serverRows(
  live: readonly LiveServerLike[],
  configFor: (id: string) => ServerConfigLike | undefined,
): ServerRow[] {
  return live.map((server) => {
    const config = configFor(server.id) ?? {};
    const npm = config.source && typeof config.source.npm === 'string' ? config.source.npm : undefined;
    const url = typeof config.url === 'string' && config.url !== '' ? config.url : undefined;
    const kind = npm && OUR_PACKAGE_SPEC.test(npm)
      ? npm
      : npm ? 'a registry package'
      : url ? 'a url server'
      : typeof config.command === 'string' ? 'a local command'
      : 'unknown';
    const transport = config.transport === 'websocket' || (url && config.transport !== 'stdio')
      ? 'websocket'
      : config.transport === 'stdio' || typeof config.command === 'string' ? 'stdio' : 'unknown';
    return {
      kind,
      transport,
      family: config.protocol === 'modern' ? 'modern' : 'legacy',
      connected: server.connected === true,
      retrying: server.retrying === true,
      // `refused` is a sentence naming the server and its url: only whether
      // there is one goes in.
      refused: server.refused !== undefined && server.refused !== null && server.refused !== false,
      toolCount: count(server.toolCount) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Provider failures, from this process's llm-calls file
// ---------------------------------------------------------------------------

/**
 * The last hour's provider calls, as counts and classifications. A record's
 * request, response and error text are never read into the report.
 */
export function summarizeProviderCalls(lines: readonly string[], now: Date, recentMax = 10): ProviderCallSummary {
  const since = now.getTime() - 60 * 60 * 1000;
  let calls = 0;
  let failed = 0;
  const failures: ProviderFailure[] = [];
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof record.timestamp === 'string' && ISO.test(record.timestamp) ? record.timestamp : null;
    if (!at || Date.parse(at) < since || Date.parse(at) > now.getTime() + 60_000) continue;
    if (record.type !== 'call' && record.type !== 'error') continue;
    calls++;
    if (record.type !== 'error') continue;
    failed++;
    const status = typeof record.httpStatus === 'number' && Number.isInteger(record.httpStatus)
      && record.httpStatus >= 100 && record.httpStatus <= 599 ? record.httpStatus : null;
    failures.push({
      at: at.replace(/\.\d+Z$/, 'Z'),
      kind: record.kind === 'complete' || record.kind === 'stream' ? record.kind : null,
      provider: typeof record.provider === 'string' && PROVIDERS.has(record.provider) ? record.provider : null,
      status,
      type: typeof record.errorType === 'string' && MEMBRANE_ERROR_TYPES.has(record.errorType) ? record.errorType : null,
      retryable: typeof record.retryable === 'boolean' ? record.retryable : null,
      code: typeof record.providerErrorCode === 'string'
        ? PROVIDER_ERROR_CODES.has(record.providerErrorCode) ? record.providerErrorCode : 'other'
        : null,
    });
  }
  return { calls, failed, recent: failures.slice(-recentMax).reverse() };
}

// ---------------------------------------------------------------------------
// Host errors, from the error log, as shapes
// ---------------------------------------------------------------------------

const SESSION_MARKER = /^--- session \d{4}-\d{2}-\d{2}T[\d:.]+Z ---$/;
const LEADING_STAMP = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s*/;
const TAG = /^\[([A-Za-z0-9:_./-]{1,40})\]/;
const FRAME = /^\s+at\s+(?:.*?\()?((?:file:\/\/)?\/[^():\s]+?\.(?:ts|tsx|js|mjs|cjs)):(\d+)(?::\d+)?\)?\s*$/;

/** A frame's location inside our own code, `package/path:line`, or null
 *  for any other frame: connectome-host's files under `root` (wherever it
 *  is installed), and our dependencies under node_modules/@animalabs.
 *  `exists` confirms the file is real, so a line that only looks like a
 *  frame can't bring in a made-up path. */
export function ourFrame(path: string, line: string, root: string, exists: (file: string) => boolean): string | null {
  let file: string;
  try {
    file = path.startsWith('file://') ? fileURLToPath(path) : path;
  } catch {
    return null;
  }
  const located = ((): string | null => {
    const parts = file.split(sep);
    for (let i = parts.length - 2; i >= 1; i--) {
      if (parts[i - 1] === '@animalabs' && parts[i - 2] === 'node_modules' && OUR_PACKAGES.includes(parts[i]!)) {
        return `@animalabs/${parts[i]}/${parts.slice(i + 1).join('/')}`;
      }
    }
    if (file.startsWith(root + sep) && !file.slice(root.length + 1).split(sep).includes('node_modules')) {
      return `connectome-host/${relative(root, file).split(sep).join('/')}`;
    }
    return null;
  })();
  if (!located || !/^[@A-Za-z0-9_./-]{1,200}$/.test(located) || located.includes('..')) return null;
  if (!/^\d{1,7}$/.test(line) || !exists(file)) return null;
  return `${located}:${line}`;
}

/** The error-log text of this session: after its last session marker. */
export function currentSession(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SESSION_MARKER.test(lines[i]!.trim())) return lines.slice(i + 1).join('\n');
  }
  return text;
}

/**
 * The shapes in an error log: how many lines each of our tags began, how
 * many began with any other tag, and each distinct error by class and where
 * it was thrown in our code. No text of any line is kept.
 */
export function parseErrorLog(
  text: string,
  root: string,
  exists: (file: string) => boolean,
): { tags: Map<string, number>; otherTags: number; errors: HostErrorShape[] } {
  const tags = new Map<string, number>();
  let otherTags = 0;
  const shapes = new Map<string, HostErrorShape>();
  let current: { className: string; frames: string[] } | null = null;
  const close = (): void => {
    if (!current) return;
    if (current.className !== '' || current.frames.length > 0) {
      const className = current.className || 'Error';
      const key = `${className}|${current.frames.join('|')}`;
      const seen = shapes.get(key);
      if (seen) seen.count++;
      else shapes.set(key, { className, frames: current.frames, count: 1, signature: createHash('sha256').update(key).digest('hex').slice(0, 8) });
    }
    current = null;
  };
  for (const raw of text.split('\n')) {
    const frame = FRAME.exec(raw);
    if (frame) {
      if (!current) current = { className: '', frames: [] };
      if (current.frames.length < 3) {
        const where = ourFrame(frame[1]!, frame[2]!, root, exists);
        if (where && !current.frames.includes(where)) current.frames.push(where);
      }
      continue;
    }
    close();
    const line = raw.replace(LEADING_STAMP, '');
    const tag = TAG.exec(line);
    if (tag) {
      const name = tag[1]!.toLowerCase();
      if (HOST_LOG_TAGS.has(name)) tags.set(name, (tags.get(name) ?? 0) + 1);
      else otherTags++;
    }
    // An error's header names its class before a colon. Only a known class
    // is named; the rest of the line is never read.
    const header = /(?:^|[\s(\[])((?:[A-Z][A-Za-z0-9]*)?Error)(?::|\s*$)/.exec(line);
    if (header) current = { className: ERROR_CLASSES.has(header[1]!) ? header[1]! : 'another error class', frames: [] };
  }
  close();
  const errors = [...shapes.values()].sort((a, b) => b.count - a.count);
  return { tags, otherTags, errors };
}

// ---------------------------------------------------------------------------
// The report's text and its link
// ---------------------------------------------------------------------------

export interface BugReport {
  title: string;
  /** The user's text, verbatim: the form's "What happened". */
  what: string;
  /** The assembled report: the form's "Report". */
  report: string;
}

const LEFT_OUT = 'Left out: every log line and error message; llm-calls requests, responses and errors; '
  + 'the system prompt and all other recipe text; server names, commands, args and URLs; env values; file paths. '
  + 'We may ask whether you can share more.';

function onOff(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'on' : 'off';
}

export function formatBugReport(text: string, facts: BugReportFacts, opts: { brief?: boolean } = {}): BugReport {
  const firstLine = text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  const titleText = firstLine.length > TITLE_CHARS ? `${[...firstLine].slice(0, TITLE_CHARS - 1).join('')}…` : firstLine;
  const lines: string[] = [];
  lines.push(`${BUG_REPORT_MARKER} · ${facts.now.toISOString().replace(/\.\d+Z$/, 'Z')}`);
  lines.push('This part was assembled by /bug. "What happened" is the reporter\'s own words.');
  lines.push('');
  lines.push('Environment');
  const commit = facts.host.commit
    ? ` (commit ${facts.host.commit.sha.slice(0, 12)}, modified: ${facts.host.commit.modified === null ? 'unknown' : facts.host.commit.modified ? 'yes' : 'no'})`
    : '';
  lines.push(`  connectome-host ${facts.host.version ?? 'unknown'}${commit} · mode: ${facts.mode}`);
  lines.push(`  ${facts.packages.map((p) => `${p.name.replace('@animalabs/', '')} ${p.version ?? 'unknown'}`).join(' · ')}`);
  const rt = facts.runtime;
  lines.push(`  ${rt.bun ? `bun ${rt.bun}` : 'no bun'}${rt.node ? ` (node ${rt.node})` : ''} · ${rt.os}${rt.release ? ` ${rt.release}` : ''} ${rt.arch}`);
  lines.push('');
  lines.push('Setup');
  const s = facts.setup;
  lines.push(`  provider: ${s.provider ?? 'unknown'} · model: ${s.model ?? 'unknown'}${s.formatter ? ` · formatter: ${s.formatter}` : ''}`);
  lines.push(`  maxTokens: ${s.maxTokens ?? 'default'} · contextBudgetTokens: ${s.contextBudgetTokens ?? 'default'} · cacheTtl: ${s.cacheTtl ?? 'default'} · proseRouting: ${s.proseRouting ?? 'default'} · thinking: ${s.thinking === null ? 'default' : onOff(s.thinking)}`);
  lines.push(`  modules: ${s.modules.length > 0 ? s.modules.join(', ') : 'none'}${s.customModules > 0 ? ` · custom: ${s.customModules}` : ''}`);
  lines.push('');
  lines.push(`MCP servers${facts.servers.length === 0 ? ': none' : ''}`);
  facts.servers.forEach((row, index) => {
    const state = row.refused ? 'refused' : row.connected ? 'connected' : row.retrying ? 'retrying' : 'not connected';
    lines.push(`  server ${index + 1}: ${row.kind} · ${row.transport} · ${row.family} · ${state} · ${row.toolCount} tools`);
  });
  lines.push('');
  if (facts.providerCalls) {
    const pc = facts.providerCalls;
    lines.push(`Provider calls, last hour: ${pc.calls}, ${pc.failed} failed`);
    if (opts.brief && pc.recent.length > 0) {
      lines.push(`  (the ${pc.recent.length} newest failures are left out to fit the link)`);
    } else {
      for (const f of pc.recent) {
        lines.push(`  ${f.at} ${f.kind ?? '?'} ${f.provider ?? '?'} ${f.status ?? '?'} ${f.type ?? '?'}${f.retryable === null ? '' : f.retryable ? ' retryable' : ' not retryable'}${f.code ? ` ${f.code}` : ''}`);
      }
    }
    const newest = pc.recent[0];
    if (newest) lines.push(`  signature: ${newest.provider ?? '?'}/${newest.status ?? '?'}/${newest.type ?? '?'}/${newest.code ?? '-'}`);
  } else {
    lines.push('Provider calls: no call log in this process');
  }
  lines.push('');
  if (facts.hostErrors) {
    const he = facts.hostErrors;
    lines.push(`Host errors this session (${he.log})`);
    const tagText = he.tags.map(([name, n]) => `${name} ${n}`);
    if (he.otherTags > 0) tagText.push(`other ${he.otherTags}`);
    lines.push(`  tags: ${tagText.length > 0 ? tagText.join(', ') : 'none'}`);
    if (he.errors.length === 0) lines.push('  errors: none');
    const shown = opts.brief ? he.errors.slice(0, 3) : he.errors.slice(0, 10);
    for (const error of shown) {
      lines.push(`  ${error.className} ×${error.count} · sig ${error.signature}`);
      if (!opts.brief) for (const frame of error.frames) lines.push(`    ${frame}`);
    }
    if (he.errors.length > shown.length) lines.push(`  (${he.errors.length - shown.length} more distinct errors left out to fit)`);
  } else {
    lines.push('Host errors: this mode keeps no error log (it prints to the terminal)');
  }
  lines.push('');
  lines.push(LEFT_OUT);
  return { title: `[/bug] ${titleText}`, what: text, report: lines.join('\n') };
}

/** The new-issue link, filled in by field id. Never `labels=`: GitHub
 *  answers 404 to a reporter without permission to label. */
export function bugReportUrl(report: BugReport): string {
  const params = new URLSearchParams({
    template: BUG_REPORT_TEMPLATE,
    title: report.title,
    what: report.what,
    report: report.report,
  });
  return `https://github.com/${BUG_REPORT_REPO}/issues/new?${params.toString()}`;
}

/**
 * The report and its link, within the link's cap. Past it, the lists
 * collapse first, then the user's own text is cut, each saying so; the
 * local file keeps the whole text for them to paste.
 */
export function buildBugReport(text: string, facts: BugReportFacts): { full: BugReport; linked: BugReport; url: string; cut: string[] } {
  const full = formatBugReport(text, facts);
  let linked = full;
  const cut: string[] = [];
  if (bugReportUrl(linked).length > BUG_REPORT_URL_CAP) {
    linked = formatBugReport(text, facts, { brief: true });
    cut.push('the failure list and error frames');
  }
  if (bugReportUrl(linked).length > BUG_REPORT_URL_CAP) {
    const fixed = bugReportUrl({ ...linked, what: '' }).length;
    const room = Math.max(0, BUG_REPORT_URL_CAP - fixed - 200);
    let points = [...text];
    // Shorten until the encoded text fits the room left.
    let keep = points.length;
    while (keep > 0 && encodeURIComponent(points.slice(0, keep).join('')).length > room) keep = Math.floor(keep * 0.8);
    const omitted = points.length - keep;
    points = points.slice(0, keep);
    linked = { ...linked, what: `${points.join('')}\n\n[${omitted} characters cut to fit the link; the whole text is in the report file]` };
    cut.push('part of "What happened"');
  }
  return { full, linked, url: bugReportUrl(linked), cut };
}

// ---------------------------------------------------------------------------
// Gathering the facts
// ---------------------------------------------------------------------------

/** How this process runs, by index.ts's own rule: headless with
 *  --headless; otherwise batch when stdin isn't a terminal, readline with
 *  --no-tui, and the TUI by default. */
export function runtimeMode(argv: readonly string[] = process.argv, stdinIsTTY = !!process.stdin.isTTY): RuntimeMode {
  if (argv.includes('--headless')) return 'headless';
  if (!stdinIsTTY) return 'batch';
  if (argv.includes('--no-tui')) return 'readline';
  return 'tui';
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A dependency's version, from the nearest node_modules that has it. */
function dependencyVersion(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = readJson(join(dir, 'node_modules', name, 'package.json'));
    if (pkg) return version(pkg.version);
    if (dirname(dir) === dir) return null;
  }
}

/** The commit this checkout is at, and whether tracked files are modified. */
function hostCommit(root: string): BugReportFacts['host']['commit'] {
  if (!existsSync(join(root, '.git'))) return null;
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000 });
  const sha = head.status === 0 ? head.stdout.trim() : '';
  if (!SHA.test(sha)) return null;
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', timeout: 3000 });
  return { sha, modified: status.status === 0 ? status.stdout.trim() !== '' : null };
}

/** The last `bytes` of a file as lines, the first (likely partial) dropped. */
export function tailLines(path: string, bytes: number): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** This process's llm-calls file: the newest one in the data directory. */
function newestCallLog(dataDir: string): string | null {
  try {
    const names = readdirSync(dataDir).filter((name) => /^llm-calls\..*\.jsonl$/.test(name)).sort();
    return names.length > 0 ? join(dataDir, names[names.length - 1]!) : null;
  } catch {
    return null;
  }
}

export interface GatherOptions {
  now?: Date;
  mode: RuntimeMode;
  dataDir: string;
  recipe: RecipeLike;
  liveServers: readonly LiveServerLike[];
  /** Server configurations by id: the recipe's, then the servers file's. */
  serverConfig: (id: string) => ServerConfigLike | undefined;
  /** The checkout or install to report on; this one by default. */
  root?: string;
}

export function gatherBugReportFacts(opts: GatherOptions): BugReportFacts {
  const now = opts.now ?? new Date();
  const root = opts.root ?? ROOT;
  const pkg = readJson(join(root, 'package.json'));
  const packages = ['@animalabs/agent-framework', '@animalabs/membrane', '@animalabs/context-manager', '@animalabs/chronicle']
    .map((name) => ({ name, version: dependencyVersion(name, root) }));
  const callLog = newestCallLog(opts.dataDir);
  const errorLogName = opts.mode === 'tui' ? 'tui-error.log' : opts.mode === 'headless' ? 'headless.log' : null;
  let hostErrors: HostErrorSummary | null = null;
  if (errorLogName) {
    const session = currentSession(tailLines(join(opts.dataDir, errorLogName), 4 * 1024 * 1024).join('\n'));
    const parsed = parseErrorLog(session, root, (file) => existsSync(file));
    hostErrors = {
      log: errorLogName,
      tags: [...parsed.tags.entries()].sort((a, b) => b[1] - a[1]),
      otherTags: parsed.otherTags,
      errors: parsed.errors,
    };
  }
  const releaseText = release();
  return {
    now,
    mode: opts.mode,
    host: { version: version(pkg?.version), commit: hostCommit(root) },
    packages,
    runtime: {
      os: platform(),
      release: /^[0-9A-Za-z._+-]{1,60}$/.test(releaseText) ? releaseText : null,
      arch: arch(),
      bun: version(process.versions.bun),
      node: version(process.versions.node),
    },
    setup: setupFacts(opts.recipe),
    servers: serverRows(opts.liveServers, opts.serverConfig),
    providerCalls: callLog ? summarizeProviderCalls(tailLines(callLog, 4 * 1024 * 1024), now) : null,
    hostErrors,
  };
}
