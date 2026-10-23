- **Agents on Fable 5/5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5:** the notes these models write between
  tool calls ("found X, checking Y next") come back as signed `thinking` blocks, empty under thinking
  display `'omitted'`, which is also what the API applies when no thinking config is sent. On these
  models (dated snapshot IDs included) the host now sends `thinking: { type: 'adaptive', display:
  'updates' }` on agent turns (streamed calls; one-shot `complete()` calls make no tool calls and are
  left as built) wherever it would have left display at `'omitted'`: with reasoning off (these models think anyway), and with
  `reasoning_display` or a recipe's `agent.thinking.display` set to `'omitted'`. Reasoning stays hidden
  as before, and the notes come back as text, in stores, logs and the web UI. `'summarized'`, which
  already returns them (mixed with reasoning summaries), and other models are unchanged. Needs
  membrane 0.7.0 or later, which adds the `thinking-display-updates-2026-08-18` beta that `'updates'`
  requires.
  - **Cache:** the first call after upgrading sends a thinking config where none or `'omitted'` went
    before, so the cached message prefix may be written again, once.
- `agent_settings`' `reasoning_display` description no longer tells the agent its reasoning is lost
  to it on replay under `'omitted'`: a thinking block sent back gives the model its full reasoning
  either way, and the setting changes only what is recorded as readable text.
