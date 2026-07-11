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
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
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
