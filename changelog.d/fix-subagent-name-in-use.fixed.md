- A spawn or fork whose name a subagent already has, from its spawn until
  its result has come back, is now refused, naming that subagent and
  whether it's running, waiting for a concurrency slot or finishing. Before,
  it was accepted, and the name then pointed at the second run alone, so
  the first could no longer be cancelled by its name. Names are shared
  across the whole tree of subagents: a fork that forks again can't take a
  name another subagent has at any level, and gets the refusal instead.
