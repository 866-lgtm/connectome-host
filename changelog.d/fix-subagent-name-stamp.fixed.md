- A spawned subagent's retry, or a new spawn or fork run under a name an
  earlier run used, no longer fails with "Ephemeral agent name … is already
  registered or has been used in this framework" when it starts in the same
  millisecond as an earlier attempt. The number that ends every agent name
  the subagent module makes is the time in milliseconds, or one past the
  last name's number once that has caught up with the time, so no name the
  module makes repeats while the host runs.
