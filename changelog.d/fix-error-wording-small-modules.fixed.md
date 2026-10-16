- The smaller modules' errors now say what was wrong and what the agent
  can do: `activity`, `channel-mode`, `lessons`, `settings`, `notices`,
  `instructions`, `retrieval`, `time`, `tts-relay`, `tui` and `webui`. A
  call to a tool a module doesn't have names the tools it has, from the
  module's own list, or says it has none and where the agent should look
  instead: `agent_settings` for reasoning, the workspace file for
  instructions. Refusals name every wrong argument at once, with the value
  given. A partly applied `channel-mode--set_channel_mode` says what each
  step that worked did, what failed, and how to retry, `debounceMs`
  included; one where no step worked says nothing changed, and one with a
  step that got no answer says it may not have changed. The
  `[host-notice]` marker says the agent couldn't respond only for an
  outage or a failure of the agent's own turns. Another status notice,
  such as a credential expiring, says it was for whoever runs the host and
  needs nothing from the agent, where it used to claim the agent couldn't
  respond; an episode with both gets a marker of each.
- `channel-mode--set_channel_mode` checks `debounceMs` before it changes
  anything, in either mode. Before, a value outside the gate's 100–300000
  ms opened the channel and pinned it open, and only then failed on the
  gate rule; one that wasn't a number, such as `"60000"` or `null`, became
  the default (180000 ms unless the recipe sets another) without a word.
  Both are now refused, naming the value, and in mentions mode, which
  ignored it, a `debounceMs` that's given is checked too. A recipe's
  `defaultDebounceMs` above zero but outside those bounds, which made
  every call that left `debounceMs` out fail, is now clamped to the nearer
  bound; one at or below zero, or not a number, gives 180000 as before.
  Either way, a `[gate]` line in the host's log says so.
- `lessons--create` and `lessons--update` check every field they're given
  before changing anything: content must be text that isn't blank, tags
  and evidence lists of text, and confidence a number from 0 to 1. `null`
  counts as given and is refused; on update, leaving a field out keeps it.
  `lessons--create` needs content and tags, and `lessons--deprecate` needs
  a `reason` that isn't blank. Each refusal names every problem. Before, a
  lesson was stored as given: one stored without tags (or content) made
  every later `lessons--query` by tags (or text) fail, a confidence of 85
  was kept as 8500%, and on update a `null` confidence became 0 and a
  `null` evidence threw after the content had changed.
- `agent_settings`' `reasoning_budget_tokens` must be a number. Before,
  `null`, `true` or `"60000"` was turned into one, and `null` or `true`
  then set the budget to the 1024 minimum without a word.
