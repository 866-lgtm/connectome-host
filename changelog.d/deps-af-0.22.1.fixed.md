- Depend on released `@animalabs/agent-framework` 0.22.1.
  - **Provider waits:** a provider's stated `retry-after` now holds the
    agent's turns, recorded in the store and kept across restarts. Under
    agent-framework 0.22.0, which 0.10.0 and 0.10.1 lock, a long
    `retry-after` was slept inside the turn, and stopping the host couldn't
    end the sleep. A wait longer than an hour raises a `provider-wait` ops
    alert. agent-framework's `release-provider-wait` host command lifts a
    wait; connectome-host has no TUI or Web UI command for it, so it is sent
    by an MCPL server allowed to send host commands.
  - **Subagents:** a subagent is an ephemeral run, which sleeps a provider's
    stated wait of up to ten minutes and now ends at once on a longer one,
    its error naming the wait. Under agent-framework 0.22.0 it slept the
    whole wait. The subagent module now fails such a subagent without
    restarting it, since a restart would only call the provider again
    inside the wait it asked for. Other rate-limit errors are still retried.
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
    emoji. connectome-host still sets its own refusal-only
    `DISCORD_SUPPRESSED_REACTIONS_BASELINE` on each child, which replaces
    that default, so the reactions residents see don't change. The framework
    logs this whenever it adds a stdio server, at startup or at runtime:
    "DISCORD_SUPPRESSED_REACTIONS_BASELINE from its env replaces the
    framework's protective default".
  - **Going back:** agent-framework 0.22.1's notes say a framework can go
    back to 0.22.0 and open a store 0.22.1 wrote, ignoring the recorded
    waits, so a long `retry-after` is slept inside the turn again. They say
    going back under connectome-host wasn't tested.
