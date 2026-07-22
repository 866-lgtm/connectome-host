/**
 * Provider-neutral logging wrapper — appends each LLM call's raw request,
 * response, and errors to a JSONL log file, identical in shape to
 * LoggingAnthropicAdapter's log entries.
 *
 * Wraps any ProviderAdapter (e.g. OpenAICompatibleAdapter) and intercepts
 * complete()/stream() to capture the raw provider request via the membrane
 * onRequest hook and the raw response.
 *
 * Unlike LoggingAnthropicAdapter, this wrapper does NOT inject reasoning
 * (thinking blocks are Anthropic-native). The reasoning getter is accepted
 * but unused for non-Anthropic providers.
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '@animalabs/membrane';
import { appendFileSync } from 'node:fs';
import type { ReasoningGetter } from './logging-adapter.js';

/**
 * JSON.stringify replacer that strips inlined image/audio payloads from log
 * records. These base64 blobs (Discord images inlined into every request, in
 * both the raw provider format and the normalized format) are what made
 * llm-calls*.jsonl balloon to multi-GB/day and compress poorly. Replacing them
 * with a size placeholder keeps the logs forensically useful (all TEXT blocks,
 * tool schemas, and structure survive — the check-dropped-text scanner still
 * works) while cutting size by orders of magnitude.
 *
 * Targets only genuine base64: a `data:<type>;base64,…` URL, or a long string
 * over the base64 alphabet with no whitespace/punctuation. Legitimate prose,
 * JSON, and tool schemas always contain spaces/newlines, so they never match.
 */
const IMAGE_STRIP_MIN = 2048; // chars; real images are far larger than this
function stripInlineMedia(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > IMAGE_STRIP_MIN) {
    const kb = Math.round(value.length / 1024);
    const dataUrl = /^(data:[^;,]+);base64,/.exec(value);
    if (dataUrl) return `${dataUrl[1]};base64,[stripped ${kb}kb]`;
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(value)) return `[base64 stripped ${kb}kb]`;
  }
  return value;
}

export class LoggingProviderAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly inner: ProviderAdapter;
  private readonly logPath: string;
  private readonly getReasoning?: ReasoningGetter;

  constructor(
    inner: ProviderAdapter,
    logPath: string,
    getReasoning?: ReasoningGetter,
  ) {
    this.inner = inner;
    this.name = this.inner.name;
    this.logPath = logPath;
    this.getReasoning = getReasoning;
  }

  supportsModel(modelId: string): boolean {
    return this.inner.supportsModel(modelId);
  }

  private log(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(record, stripInlineMedia) + '\n');
    } catch {
      // never throw from logging
    }
  }

  /** Wrap options to capture the raw provider request via the membrane
   *  onRequest hook, then chain to any caller-supplied onRequest. */
  private captureRawRequest(
    options: ProviderRequestOptions | undefined,
    sink: { rawRequest: unknown },
  ): ProviderRequestOptions {
    const callerOnRequest = options?.onRequest;
    return {
      ...options,
      onRequest: (req: unknown) => {
        sink.rawRequest = req;
        try { callerOnRequest?.(req as never); } catch { /* never block on caller hook */ }
      },
    } as ProviderRequestOptions;
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const t0 = Date.now();
    const sink: { rawRequest: unknown } = { rawRequest: null };
    const wrapped = this.captureRawRequest(options, sink);
    try {
      const response = await this.inner.complete(request, wrapped);
      this.log({
        type: 'call', kind: 'complete',
        timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        rawRequest: sink.rawRequest,
        rawResponse: (response as { raw?: unknown }).raw ?? null,
        normalizedRequest: request,
        normalizedResponse: response,
      });
      return response;
    } catch (err) {
      this.log({
        type: 'error', kind: 'complete',
        timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        rawRequest: sink.rawRequest,
        normalizedRequest: request,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      throw err;
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const t0 = Date.now();
    const sink: { rawRequest: unknown } = { rawRequest: null };
    const wrapped = this.captureRawRequest(options, sink);
    try {
      const response = await this.inner.stream(request, callbacks, wrapped);
      this.log({
        type: 'call', kind: 'stream',
        timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        rawRequest: sink.rawRequest,
        rawResponse: (response as { raw?: unknown }).raw ?? null,
        normalizedRequest: request,
        normalizedResponse: response,
      });
      return response;
    } catch (err) {
      this.log({
        type: 'error', kind: 'stream',
        timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        rawRequest: sink.rawRequest,
        normalizedRequest: request,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      throw err;
    }
  }
}
