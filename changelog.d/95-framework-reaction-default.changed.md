- **Discord reactions:** connectome-host no longer sets its own
  refusal-only `DISCORD_SUPPRESSED_REACTIONS_BASELINE` on each MCPL child,
  as agent-framework 0.22.1 asks hosts to stop doing, so each stdio child
  gets the framework's derived default. That default also covers the
  awareness emoji (💤) and retained recovery emoji. Suppression is by
  emoji, so members' own reactions with those emoji stop reaching the agent
  too, as reactions with the refusal markers (🛑, 🧠, 💻 and the others)
  already did. discord-mcpl seeds its filters file (`DISCORD_FILTERS_FILE`)
  from the baseline at its first start, so a deployment whose file was
  seeded under the host's old refusal-only baseline keeps that list, since
  the file's `suppressedReactionEmojis` key is discord-mcpl's only authority
  once set. There, members' 💤 reactions keep reaching the agent, and
  discord-mcpl logs at startup that the file lacks entries of the injected
  baseline. Adding those entries to the file gives the default's
  protection. The framework no longer logs, for each child the host starts,
  that its env replaces the protective default. A server's
  own `DISCORD_SUPPRESSED_REACTIONS_BASELINE` with tokens still replaces the
  default, and one without (blank, or commas alone) counts as unset. A
  non-string value counts as its string form, so `false` or `0` replaces the
  default too. For an `inheritEnv` server, a baseline with tokens in the
  host's own environment now replaces the default as well, where the host's
  value used to override it. The host still sets `AGENT_TIMEZONE` on every
  child. A stdio child that takes the default now reads the awareness ledger
  at each spawn, so while the ledger can't be read, its automatic reconnects
  fail and retry, whether or not it's a Discord child.
