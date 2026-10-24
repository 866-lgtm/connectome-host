/**
 * (local patch) A dedicated membrane for memory compression on its own
 * OpenAI-compatible endpoint, enabled by COMPRESSION_OPENAI_BASE_URL.
 *
 * Every call it makes passes membrane's per-call `retry: false`: context-
 * manager's compression lane retries on its own (a transient failure pauses
 * the lane with backoff, honouring a stated `retryAfterMs`), so membrane's
 * in-call schedules (base retries, the 429 floor, waited-out stated waits)
 * would only run out of the lane's sight and hold its slot. A failure comes
 * back after one send, with the provider's advice on it.
 */
import { Membrane, NativeFormatter, OpenAICompatibleAdapter } from '@animalabs/membrane';
import { LoggingProviderAdapter } from './logging-provider-wrapper.js';
import type { ReasoningGetter } from './logging-adapter.js';

type CompleteOptions = NonNullable<Parameters<Membrane['complete']>[1]>;
type StreamOptions = NonNullable<Parameters<Membrane['stream']>[1]>;
type YieldingOptions = NonNullable<Parameters<Membrane['streamYielding']>[1]>;

/** A Membrane whose every call runs with `retry: false`. */
export class NoRetryMembrane extends Membrane {
  override complete(request: Parameters<Membrane['complete']>[0], options?: CompleteOptions) {
    return super.complete(request, { ...options, retry: false });
  }

  override stream(request: Parameters<Membrane['stream']>[0], options?: StreamOptions) {
    return super.stream(request, { ...options, retry: false });
  }

  override streamYielding(request: Parameters<Membrane['streamYielding']>[0], options?: YieldingOptions) {
    return super.streamYielding(request, { ...options, retry: false });
  }
}

export interface CompressionMembraneOptions {
  baseURL: string;
  apiKey?: string;
  /** The primary's agent name: the assistant role on internal requests. */
  assistantParticipant: string;
  llmLogPath: string;
  getReasoning?: ReasoningGetter;
  /** prompt_cache_key sent on every compression call (request values win). */
  promptCacheKey?: string;
}

/** The compression membrane: OpenAI-compatible, logged to the shared llm-calls
 *  file tagged 'compression', never retrying inside a call. */
export function buildCompressionMembrane(opts: CompressionMembraneOptions): NoRetryMembrane {
  return new NoRetryMembrane(
    new LoggingProviderAdapter(
      new OpenAICompatibleAdapter({ baseURL: opts.baseURL, apiKey: opts.apiKey }),
      opts.llmLogPath,
      opts.getReasoning,
      {
        tag: 'compression',
        ...(opts.promptCacheKey ? { defaultExtra: { prompt_cache_key: opts.promptCacheKey } } : {}),
      },
    ),
    {
      formatter: new NativeFormatter(),
      assistantParticipant: opts.assistantParticipant,
    },
  );
}
