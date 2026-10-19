- `llm-calls` rows now flag anomalous provider responses. A response that
  carries a client `tool_use` block under any stop reason other than
  `tool_use` (seen in production as `end_turn` with a complete tool call,
  which the agent loop then drops without running the tool) gets an
  `anomaly` field (`kind`, `stopReason`, `providerStopReason`, `toolNames`),
  keeps its full raw request even without `LLM_CALLS_FULL_PAYLOADS`, as a
  refusal's row already did, and prints one timestamped `[llm-calls] …
  ANOMALY …` line to stderr. A raw response that lists `anomalies` of its
  own is flagged the same way (`kind: "provider_reported"`).
- Response rows also keep the provider's `messageId` and `requestId` at top
  level when the response exposes them (the request id is what a provider
  needs to look a call up). Rows are otherwise unchanged.
