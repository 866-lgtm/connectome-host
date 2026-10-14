- Depend on released `@animalabs/agent-framework` 0.22.1.
  - **Provider waits:** a provider's stated `retry-after` now holds the
    agent's turns, recorded in the store and kept across restarts. Under
    agent-framework 0.22.0, which 0.10.0 and 0.10.1 lock, a long
    `retry-after` was slept inside the turn, and stopping the host couldn't
    end the sleep. A wait longer than an hour raises a `provider-wait` ops
    alert. If the recorded waits can't be read, no resident's or
    conversation agent's provider call goes out until they read again
    (tried every 30 s), and a `provider-wait` alert for agent `framework`
    says so. agent-framework's `release-provider-wait` host command lifts a
    wait, and lifts that hold one agent at a time, for the life of the
    process. connectome-host has no TUI or Web UI command for it, so it is
    sent by an MCPL server allowed to send host commands. These alerts reach
    `failures.log`, the TUI's alert lines and the ops webhook when one is
    configured. connectome-host's channel notices give `provider-wait` no
    tier by default, so they don't post them.
  - **Subagents:** a subagent is an ephemeral run, which sleeps a provider's
    stated wait of up to ten minutes and now ends at once on a longer one,
    or on one it can't read as a number, its error naming the wait. Under
    agent-framework 0.22.0 it slept a long wait whole. The subagent module
    now fails such a subagent without restarting it, since a restart would
    only call the provider again too soon. Other rate-limit errors are still
    retried.
  - **A misspelled model:** its 404 no longer sheds the agent's newest
    exchanges.
  - **Failure text:** a provider error that echoes the whole request no
    longer lands in the agent's context whole: the `[inference-failed]`
    marker carries an excerpt of at most 600 characters.
  - **Rollback and suppress:** a live rollback, a suppress or a
    message-granular undo answers once the change has landed, and the
    awareness reactions it schedules are delivered in the background.
  - **Discord reactions, unchanged:** agent-framework 0.22.1 also derives a
    reaction suppression default for each stdio MCPL child, covering the
    awareness emoji (💤 unless configured otherwise) and retained recovery
    emoji, and asks hosts that set the old refusal-only default to stop.
    connectome-host still sets its own refusal-only
    `DISCORD_SUPPRESSED_REACTIONS_BASELINE` on each child in this release,
    which replaces that default, so the reactions residents see don't
    change. The framework logs this whenever it adds a stdio server, at
    startup or at runtime: "DISCORD_SUPPRESSED_REACTIONS_BASELINE from its
    env replaces the framework's protective default".
  - **Going back:** agent-framework 0.22.1's notes say going back to 0.22.0
    is safe. 0.22.0 opens a store 0.22.1 wrote and ignores the recorded
    waits, so a long `retry-after` is slept inside the turn again, and a
    wait recorded before going back binds again if you return to 0.22.1
    before it passes. The notes list three cases as not tested: going back
    while the recorded waits can't be read, going back after an operator
    released a wait under 0.22.1, and going back under connectome-host
    rather than a bare framework.
