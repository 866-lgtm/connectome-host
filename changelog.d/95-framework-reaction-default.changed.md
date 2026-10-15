- **Discord reactions:** connectome-host no longer sets its own
  refusal-only `DISCORD_SUPPRESSED_REACTIONS_BASELINE` on each MCPL child,
  as agent-framework 0.22.1 asks hosts to stop doing, so each stdio child
  gets the framework's derived default. That default also covers the
  awareness emoji (💤 unless configured otherwise) and retained recovery
  emoji. Suppression is by emoji, so members' own reactions with those emoji
  stop reaching the agent too, as their 🛑 already did. The framework no
  longer logs, for each child the host starts, that its env replaces the
  protective default. A server's own `DISCORD_SUPPRESSED_REACTIONS_BASELINE`
  with tokens still replaces the default, and a blank one counts as unset.
  The host still sets `AGENT_TIMEZONE` on every child. While the awareness
  ledger can't be read, starting or restarting a stdio child that takes the
  default is refused, and an automatic reconnect of one retries.
