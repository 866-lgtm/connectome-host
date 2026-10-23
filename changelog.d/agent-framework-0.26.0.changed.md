- **Operators:** connectome-host now requires `@animalabs/agent-framework`
  ^0.26.0 (was ^0.24.1), `@animalabs/context-manager` ^0.20.0 (was ^0.18.0)
  and `@animalabs/membrane` ^0.7.1 (was ^0.6.0); the three move to membrane
  0.7 together, so an install holds one membrane copy. What operators and
  agents meet, in brief; each package's notes give it in full (membrane's
  retry changes and the host's default for them are under their own entry):
  - **Fewer silently lost turns and replies.** membrane runs complete tool
    calls a provider returns under `stop_reason: end_turn`, where it ended the
    turn without running them (with the `[llm-calls] … ANOMALY` line added
    here, such a response is now visible either way). In explicit and hybrid
    prose routing, the bounce-wake cap resets when a turn starts with a cause
    of its own, so a reply to a fresh message no longer bounces with no wake
    after a resident's third bounce.
  - **Lone UTF-16 surrogates** reach requests and the store as U+FFFD: a
    context injection or tool result carrying one no longer makes every
    request fail with a 400 or wedges the agent's next turn, and
    context-manager's edits and state writes no longer store state it can't
    read back.
  - **Workspace globs** take mount-prefixed patterns (`notes/diary/*.md`),
    and `**/` matches zero or more directories. In a mount holding a
    directory named like the mount, a pattern written relative to the mount
    finds less (agent-framework's Breaking notes).
  - **Tool results whose data is a string** reach the model as that text, no
    longer JSON-quoted; `code_execution` scripts get such a result's text in
    `content[0].text` and drop a `JSON.parse` that only unquoted it.
  - The workspace tools' descriptions changed, so the first request after
    the upgrade misses the prompt cache from the tool block on.
