- llm-call records from the provider-agnostic logging wrapper (openai-compatible,
  openrouter, codex, openai-responses, mock) now log the body the adapter
  actually sent as `rawRequest`, captured through membrane's `onRequest`
  hook — as the Anthropic and Bedrock writers already did — so wire-only
  fields (`prompt_cache_key`, `prompt_cache_retention`, `reasoning_effort`, a
  forced `tool_choice`) are visible. New fields: `rawRequestSource`
  (`'wire'`, or `'provider-request'` for an adapter that never reports its
  body, which keeps the old content), `normalizedRequest` (the
  ProviderRequest), `normalizedResponse` (the ProviderResponse minus its raw
  bodies) and `wireParams` (the wire body's small top-level params, kept even
  when the size guard drops the bodies). Inline base64 media is stripped from
  all of them.
