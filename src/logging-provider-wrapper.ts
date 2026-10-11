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
// OOM note (learned on the Anthropic path, which once logged raw+normalized+
// summary and contributed to production OOMs): we serialize the record ONCE,
// and a size guard drops the raw bodies for pathological payloads (giant
// image batches) rather than buffering multi-hundred-MB lines.
//
// Decorator safety: adapters whose complete() internally delegates to their
// own stream() (codex does) self-call the INNER method, not the wrapper —
// each membrane-level call logs exactly once.
//
// Each line: { type: 'call'|'error', provider, kind: 'complete'|'stream',
//   timestamp, durationMs, requestSummary?, response?, rawRequest?,
//   rawResponse?, error?, errorType?, httpStatus?, providerErrorCode?,
//   retryable?, errorChars?, truncated?, summaryUnavailable? }
// A record whose request or response couldn't be summarized keeps only the
// head fields and, for a failure, the error (summaryUnavailable: true).
//
// The error text is bounded (MAX_ERROR_CHARS): a provider can echo the whole
// rejected request in its error body, and that text would otherwise sit in
// the record beside the request it echoes. The size guard below drops raw
// bodies, never the error string, so the error string bounds itself.
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

/** Above this many serialized bytes, drop raw bodies and keep summaries. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** Longest error text a record keeps (head and tail, the omission stated). */
const MAX_ERROR_CHARS = 4_000;
/** Longest provider error code or type kept; real ones are short tokens. */
const MAX_CODE_CHARS = 128;

/**
 * `text` when it fits; otherwise its head and tail around a marker stating
 * how many of how many characters were omitted. The whole stays within `max`
 * whenever `max` fits the marker itself (at most 49 characters), as both
 * bounds here do; a smaller `max` gets the marker alone, longer than `max`.
 * Cuts move only toward omission, so no surrogate pair is split.
 */
function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  const isLow = (index: number): boolean => {
    const code = text.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  const marker = ` …[${text.length} of ${text.length} characters omitted]… `.length;
  const budget = Math.max(0, max - marker);
  const tail = Math.floor(budget / 4);
  let headEnd = budget - tail;
  if (headEnd > 0 && isLow(headEnd)) headEnd--;
  let tailStart = text.length - tail;
  if (tailStart < text.length && isLow(tailStart)) tailStart++;
  return `${text.slice(0, headEnd)} …[${tailStart - headEnd} of ${text.length} characters omitted]… ${text.slice(tailStart)}`;
}

/**
 * The error fields of a record: the bounded text, plus the classification a
 * membrane error carries, so a reader can tell a request-shaped rejection
 * from a transient failure without the text. Reading a hostile error never
 * throws: logging must never break inference.
 */
function describeError(error: unknown): Record<string, unknown> {
  // Each part is read on its own: a field whose getter throws loses only
  // itself, never the provider's text or the rest of its classification.
  const read = <T>(get: () => T): T | undefined => {
    try { return get(); } catch { return undefined; }
  };
  const fields: Record<string, unknown> = {};
  let text: string;
  // Even the type test is guarded: a revoked Proxy or a throwing
  // getPrototypeOf trap makes `instanceof` itself throw.
  if (read(() => error instanceof Error) === true) {
    const e = error as Error & { type?: unknown; httpStatus?: unknown; providerErrorCode?: unknown; retryable?: unknown };
    const name = read(() => String(e.name)) ?? 'Error';
    const message = read(() => String(e.message));
    text = message === undefined ? `${name}: [message could not be read]` : `${name}: ${message}`;
    const type = read(() => e.type);
    if (typeof type === 'string') fields.errorType = boundText(type, MAX_CODE_CHARS);
    const httpStatus = read(() => e.httpStatus);
    if (typeof httpStatus === 'number') fields.httpStatus = httpStatus;
    const code = read(() => e.providerErrorCode);
    if (typeof code === 'string') fields.providerErrorCode = boundText(code, MAX_CODE_CHARS);
    const retryable = read(() => e.retryable);
    if (typeof retryable === 'boolean') fields.retryable = retryable;
  } else {
    text = read(() => String(error)) ?? '[error could not be read]';
  }
  const bounded = boundText(text, MAX_ERROR_CHARS);
  return { error: bounded, ...fields, ...(bounded !== text ? { errorChars: text.length } : {}) };
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

export class LoggingProviderAdapter implements ProviderAdapter {
  readonly name: string;

  constructor(
    private readonly inner: ProviderAdapter,
    private readonly logPath: string,
  ) {
    this.name = inner.name;
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
        line = JSON.stringify(record);
      } catch {
        line = undefined;
      }
      if (line === undefined || line.length > MAX_RECORD_BYTES) {
        const { rawRequest: _rq, rawResponse: _rr, ...rest } = record;
        line = JSON.stringify({
          ...rest,
          truncated: line === undefined
            ? 'raw bodies dropped (they could not be serialized)'
            : 'raw bodies dropped (record exceeded size guard)',
        });
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
    outcome: { response: ProviderResponse } | { error: unknown },
  ): void {
    const failed = 'error' in outcome;
    const head = {
      type: failed ? 'error' : 'call',
      provider: this.name,
      kind,
      timestamp: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    };
    let record: Record<string, unknown>;
    try {
      record = {
        ...head,
        requestSummary: summarizeRequest(request),
        rawRequest: request,
        ...('response' in outcome
          ? { response: summarizeResponse(outcome.response, this.usageCacheConvention), rawResponse: outcome.response.raw ?? null }
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
    outcome: { response: ProviderResponse } | { error: unknown },
  ): void {
    try {
      this.record(kind, request, started, outcome);
    } catch {
      // Logging must never break inference, nor change what it returns or throws.
    }
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    let response: ProviderResponse;
    try {
      response = await this.inner.complete(request, options);
    } catch (error) {
      this.recordSafely('complete', request, started, { error });
      throw error;
    }
    // Outside the try: a logging failure can't be taken for the provider's.
    this.recordSafely('complete', request, started, { response });
    return response;
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    let response: ProviderResponse;
    try {
      response = await this.inner.stream(request, callbacks, options);
    } catch (error) {
      this.recordSafely('stream', request, started, { error });
      throw error;
    }
    this.recordSafely('stream', request, started, { response });
    return response;
  }
}
