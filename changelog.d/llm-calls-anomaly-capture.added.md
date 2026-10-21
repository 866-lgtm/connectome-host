- `llm-calls` rows now flag anomalous provider responses. A response that
  carries a client `tool_use` block under any stop reason other than
  `tool_use` (seen in production as `end_turn` with a complete tool call,
  which membrane before membrane#168 dropped without running) gets an
  `anomaly` field (`kind`, `stopReason`, `providerStopReason`, `toolNames`),
  keeps its full raw request even without `LLM_CALLS_FULL_PAYLOADS`, as a
  refusal's row already did, and prints one timestamped `[llm-calls] …
  ANOMALY …` line to stderr. The line says what membrane does with such
  calls, and says "full request kept" only when the row holding the request
  was written whole; otherwise it says the write failed, or what the size
  guard dropped. A missing stop reason records `stopReason: "end_turn"`
  (membrane's default) and `providerStopReason: null` on `complete()` and
  `stream()` alike.
- Anthropic `complete()` and `stream()` rows also keep the provider's
  `messageId` and `requestId` at top level when the response exposes them;
  a failed call's row keeps the `requestId` its error carries. Stream rows
  get them only with a membrane that adds them to its raw response
  (membrane#168). Keepalive, Bedrock and generic-wrapper rows don't.
- The 16 MiB size guard keeps `anomaly`, `messageId` and `requestId` at every
  step, the last one bounded, and `serializeRecordOutcome` reports which step
  a line came from.
