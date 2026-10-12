// Provider-agnostic ProviderAdapter decorator that appends each LLM call's
// request, response, usage, timing, and any error to the same
// `llm-calls.<iso>.jsonl` file the Anthropic and Bedrock paths use.
//
// Exists because llm-call logging grew adapter-by-adapter (Anthropic subclass,
// Bedrock wrapper) and the remaining providers — openai-codex (Mica),
// openrouter (K3) — had NO wire visibility at all: a post-deploy "did her
// requests actually work?" check on Mica (2026-07-26) found zero llm-calls
// files because the codex path never logged. This decorator wraps ANY
// ProviderAdapter, so a new provider gets logging by construction rather than
// by remembering to build a logging twin.
//
// Contents: full raw request and a summarized-but-complete response record
// (stop reason, usage, per-block shape, full text) on every call, plus the
// raw provider response. Retention/rotation/S3 shipping is the host box's
// llm-logs sync job's problem — this file just writes lines.
//
// Wire vs normalized request: `rawRequest` is the body the adapter actually
// sent, captured through membrane's `onRequest` hook — e.g. the Chat
// Completions JSON for openai-compatible, the only place wire-level fields
// (prompt_cache_key, prompt_cache_retention, reasoning_effort, a forced
// tool_choice, stream_options) are visible. This matches what the Anthropic
// and Bedrock writers log as `rawRequest`. An adapter that never reports its
// body falls back to the ProviderRequest (`rawRequestSource` says which).
// `normalizedRequest` is always the ProviderRequest the adapter was handed and
// `normalizedResponse` the ProviderResponse it returned, so a reader can diff
// the two representations (e.g. check that every normalized text block
// survives onto the wire). `wireParams` repeats the wire body's small
// top-level scalars/objects so they survive the size guard below when the
// raw bodies don't.
//
// OOM note (learned on the Anthropic path, which once logged raw+normalized+
// summary and contributed to production OOMs): we serialize the record ONCE,
// and a size guard drops the raw bodies for pathological payloads (giant
// image batches) rather than buffering multi-hundred-MB lines.
//
// Decorator safety: adapters whose complete() internally delegates to their
// own stream() (codex does) self-call the INNER method, not the wrapper —
// each membrane-level call logs exactly once.
//
// Each line: { type: 'call'|'error', provider, tag?, kind: 'complete'|'stream',
//   timestamp, durationMs, requestSummary?, wireParams?, response?,
//   rawRequest?, rawRequestSource?, normalizedRequest?, rawResponse?,
//   normalizedResponse?, error?, errorType?, httpStatus?, providerErrorCode?,
//   retryable?, errorChars?, truncated?, summaryUnavailable? }
// A record whose request or response couldn't be summarized keeps only the
// head fields and, for a failure, the error (summaryUnavailable: true).
//
// The error text is bounded, and read without throwing, by
// logging-error-fields.ts, which the Anthropic and Bedrock writers share: a
// provider can echo the whole rejected request in its error body, and that
// text would otherwise sit in the record beside the request it echoes. The
// size guard below drops raw bodies, never the error string, so the error
// string bounds itself.
//
// Logging never changes what the caller gets: a successful call's record is
// written after the provider call's try, and every write is guarded.

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ProviderRequestOptions,
  StreamCallbacks,
} from '@animalabs/membrane';
import { appendFileSync } from 'node:fs';
import { describeError } from './logging-error-fields.js';
import type { ReasoningGetter } from './logging-adapter.js';

/** (local patch) Replacer that collapses inlined base64 image/audio payloads
 *  to size placeholders so llm-call logs stay small. */
function stripInlineMedia(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > 2048) {
    const kb = Math.round(value.length / 1024);
    const dataUrl = /^(data:[^;,]+);base64,/.exec(value);
    if (dataUrl) return `${dataUrl[1]};base64,[stripped ${kb}kb]`;
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(value)) return `[base64 stripped ${kb}kb]`;
  }
  return value;
}

/** Above this many serialized bytes, drop raw bodies and keep summaries. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** The full-body fields the size/serialization guard drops. */
const RAW_BODY_FIELDS = ['rawRequest', 'rawResponse', 'normalizedRequest', 'normalizedResponse'] as const;

/** A wire param larger than this (serialized) is left to rawRequest. */
const MAX_WIRE_PARAM_CHARS = 1024;

/**
 * The wire body's small top-level params (model, max_tokens, reasoning_effort,
 * prompt_cache_key, tool_choice, stream_options, ...): every non-array value
 * that serializes to at most MAX_WIRE_PARAM_CHARS. Arrays (messages, tools,
 * input) and large strings (system/instructions) stay in rawRequest only.
 */
function summarizeWireParams(wire: unknown): Record<string, unknown> | undefined {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wire as Record<string, unknown>)) {
    if (value === undefined || Array.isArray(value)) continue;
    try {
      const json = JSON.stringify(value);
      if (json !== undefined && json.length <= MAX_WIRE_PARAM_CHARS) out[key] = value;
    } catch { /* unserializable: rawRequest's guard handles it */ }
  }
  return out;
}

function summarizeRequest(request: ProviderRequest): Record<string, unknown> {
  const msgs = (request.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  const last = msgs[msgs.length - 1];
  const lastPreview = typeof last?.content === 'string'
    ? last.content.slice(0, 200)
    : Array.isArray(last?.content)
      ? (last.content as Array<{ type?: string; text?: string } | null>)
          .map((b) => (b?.type === 'text' ? (b.text ?? '').slice(0, 120) : `[${b?.type}]`))
          .join(' | ').slice(0, 300)
      : undefined;
  return {
    model: request.model,
    maxTokens: request.maxTokens,
    messageCount: msgs.length,
    systemChars: typeof request.system === 'string'
      ? request.system.length
      : Array.isArray(request.system)
        ? JSON.stringify(request.system).length
        : 0,
    toolNames: (request.tools as Array<{ name?: string } | null> | undefined)?.map((t) => t?.name) ?? null,
    toolCount: (request.tools as unknown[] | undefined)?.length ?? 0,
    lastMessageRole: last?.role,
    lastMessagePreview: lastPreview,
  };
}

function summarizeResponse(response: ProviderResponse, convention: ProviderAdapter['usageCacheConvention']): Record<string, unknown> {
  // Read defensively: a null block or tool costs only its own entry. What
  // can't be read at all makes record() fall back to a minimal record.
  const content = (response.content ?? []) as Array<{ type?: string; text?: string; name?: string } | null>;
  return {
    stopReason: response.stopReason
      ?? (response.raw as { stop_reason?: string } | undefined)?.stop_reason
      ?? null,
    usage: response.usage ? { ...response.usage, cacheConvention: response.usage.cacheConvention ?? convention ?? 'unknown' } : null,
    blocks: content.map((b) => ({
      type: b?.type,
      ...(b?.type === 'text' ? { chars: (b.text ?? '').length, text: b.text } : {}),
      ...(b?.type === 'tool_use' ? { name: b.name } : {}),
    })),
  };
}

/** The body an adapter reported through `onRequest` (the last one, if several). */
interface WireCapture { captured: boolean; body: unknown }

/** The ProviderResponse minus its raw bodies (`raw` is logged as rawResponse,
 *  `rawRequest` as rawRequest), so neither is written twice. */
function withoutRawBodies(response: ProviderResponse): Record<string, unknown> {
  const { raw: _raw, rawRequest: _rawRequest, ...rest } = response as ProviderResponse & { raw?: unknown; rawRequest?: unknown };
  return rest;
}

export class LoggingProviderAdapter implements ProviderAdapter {
  readonly name: string;

  /** Credential-monitor taps (see LoggingAnthropicAdapter). */
  onProviderError?: (error: unknown, kind: 'complete' | 'stream') => void;
  onProviderSuccess?: (kind: 'complete' | 'stream') => void;

  constructor(
    private readonly inner: ProviderAdapter,
    private readonly logPath: string,
    /** (local patch) Runtime reasoning kill switch: when the agent's
     *  reasoning setting is disabled, strip the recipe's `reasoning` param. */
    private readonly getReasoning?: ReasoningGetter,
    /** (local patch) Purpose tag stamped on every record as `tag` (e.g.
     *  'compression' for the dedicated summarizer endpoint), so calls that
     *  share a provider name and log file stay tell-apart-able. */
    private readonly options: { tag?: string } = {},
  ) {
    this.name = inner.name;
  }

  private withReasoning(request: ProviderRequest): ProviderRequest {
    const r = this.getReasoning?.();
    if (!r || r.enabled) return request;
    const extra = request.extra as Record<string, unknown> | undefined;
    if (!extra || extra.reasoning === undefined) return request;
    const { reasoning: _reasoning, ...rest } = extra;
    return { ...request, extra: rest };
  }

  get usageCacheConvention(): ProviderAdapter['usageCacheConvention'] {
    return this.inner.usageCacheConvention;
  }

  get requiresNativeResponsesInput(): ProviderAdapter['requiresNativeResponsesInput'] {
    return this.inner.requiresNativeResponsesInput;
  }

  // Optional in newer membrane releases; preserve the inner provider's media
  // policy without imposing it on older adapters that do not advertise one.
  get toolResultImageMediaTypes(): ReadonlySet<string> | undefined {
    return (this.inner as ProviderAdapter & {
      readonly toolResultImageMediaTypes?: ReadonlySet<string>;
    }).toolResultImageMediaTypes;
  }

  supportsModel(modelId: string): boolean {
    return this.inner.supportsModel(modelId);
  }

  /**
   * Append one record. When it can't be serialized whole (a cycle or a
   * BigInt in a raw body), or it's over the size guard, the raw bodies are
   * dropped and the rest kept, so the error text survives either way.
   */
  private log(record: Record<string, unknown>): void {
    try {
      let line: string | undefined;
      try {
        line = JSON.stringify(record, stripInlineMedia);
      } catch {
        line = undefined;
      }
      if (line === undefined || line.length > MAX_RECORD_BYTES) {
        const rest = Object.fromEntries(
          Object.entries(record).filter(([k]) => !(RAW_BODY_FIELDS as readonly string[]).includes(k)),
        );
        try {
          line = JSON.stringify({
            ...rest,
            truncated: line === undefined
              ? 'raw bodies dropped (they could not be serialized)'
              : 'raw bodies dropped (record exceeded size guard)',
          });
        } catch {
          // Even the summaries can't be serialized (a BigInt in usage, say):
          // keep the head and the error alone, so the call is never silent.
          const keep = ['type', 'provider', 'tag', 'kind', 'timestamp', 'durationMs', 'error', 'errorType',
            'httpStatus', 'providerErrorCode', 'retryable', 'errorChars'];
          line = JSON.stringify({
            ...Object.fromEntries(keep.filter((k) => k in record).map((k) => [k, record[k]])),
            truncated: 'only the head and the error kept (the record could not be serialized)',
          });
        }
      }
      appendFileSync(this.logPath, line + '\n');
    } catch {
      // Logging must never break inference.
    }
  }

  /**
   * Record one call's outcome. A call failed exactly when `outcome` carries
   * `error`, whatever its value: a rejection with undefined is a failure too.
   * If the request or response can't be summarized (a value the summaries
   * can't read), a minimal record is written instead, so a call is never
   * silent: its provider, kind, timing and, for a failure, the bounded error.
   */
  private record(
    kind: 'complete' | 'stream',
    request: ProviderRequest,
    started: number,
    wire: WireCapture,
    outcome: { response: ProviderResponse } | { error: unknown },
  ): void {
    const failed = 'error' in outcome;
    // The credential monitor's taps (main's 8ed0a18). They follow the
    // explicit outcome, so a rejection with undefined is reported as the
    // failure it is.
    try {
      if (failed) this.onProviderError?.(outcome.error, kind);
      else this.onProviderSuccess?.(kind);
    } catch { /* observers never affect provider traffic */ }
    const head = {
      type: failed ? 'error' : 'call',
      provider: this.name,
      ...(this.options.tag ? { tag: this.options.tag } : {}),
      kind,
      timestamp: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    };
    let record: Record<string, unknown>;
    try {
      // The wire body: from onRequest, else from the response's own
      // rawRequest (adapters that report it only there), else none.
      const responseWire = 'response' in outcome
        ? (outcome.response as { rawRequest?: unknown }).rawRequest
        : undefined;
      const hasWire = wire.captured || (responseWire !== undefined && responseWire !== null);
      const wireBody = wire.captured ? wire.body : responseWire;
      const wireParams = hasWire ? summarizeWireParams(wireBody) : undefined;
      record = {
        ...head,
        requestSummary: summarizeRequest(request),
        ...(wireParams ? { wireParams } : {}),
        rawRequest: hasWire ? wireBody : request,
        rawRequestSource: hasWire ? 'wire' : 'provider-request',
        normalizedRequest: request,
        ...('response' in outcome
          ? {
              response: summarizeResponse(outcome.response, this.usageCacheConvention),
              rawResponse: outcome.response.raw ?? null,
              normalizedResponse: withoutRawBodies(outcome.response),
            }
          : {}),
        ...(failed ? describeError(outcome.error) : {}),
      };
    } catch {
      record = { ...head, summaryUnavailable: true, ...(failed ? describeError(outcome.error) : {}) };
    }
    this.log(record);
  }

  /** Record a call; nothing here may replace the provider's response or its error. */
  private recordSafely(
    kind: 'complete' | 'stream',
    request: ProviderRequest,
    started: number,
    wire: WireCapture,
    outcome: { response: ProviderResponse } | { error: unknown },
  ): void {
    try {
      this.record(kind, request, started, wire, outcome);
    } catch {
      // Logging must never break inference, nor change what it returns or throws.
    }
  }

  /**
   * Options whose `onRequest` captures the wire body into `wire`, then chains
   * to the caller's hook (membrane's own: raw-request bookkeeping and wire
   * cache receipts). A throwing caller hook propagates exactly as it would
   * unwrapped; the capture itself never throws.
   */
  private captureWire(options: ProviderRequestOptions | undefined, wire: WireCapture): ProviderRequestOptions {
    const callerOnRequest = options?.onRequest;
    return {
      ...options,
      onRequest: (req: unknown) => {
        wire.captured = true;
        wire.body = req;
        callerOnRequest?.(req);
      },
    };
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    request = this.withReasoning(request);
    const started = Date.now();
    const wire: WireCapture = { captured: false, body: undefined };
    let response: ProviderResponse;
    try {
      response = await this.inner.complete(request, this.captureWire(options, wire));
    } catch (error) {
      this.recordSafely('complete', request, started, wire, { error });
      throw error;
    }
    // Outside the try: a logging failure can't be taken for the provider's.
    this.recordSafely('complete', request, started, wire, { response });
    return response;
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    request = this.withReasoning(request);
    const started = Date.now();
    const wire: WireCapture = { captured: false, body: undefined };
    let response: ProviderResponse;
    try {
      response = await this.inner.stream(request, callbacks, this.captureWire(options, wire));
    } catch (error) {
      this.recordSafely('stream', request, started, wire, { error });
      throw error;
    }
    this.recordSafely('stream', request, started, wire, { response });
    return response;
  }
}
