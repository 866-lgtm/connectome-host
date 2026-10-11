- A headless child stops treating a client as current once its socket ends or
  closes, including a reset with no `end`, such as a parent that died with
  events still unread, and writes no telemetry to a socket that has ended or
  errored. Commands the child reads from a client after a newer client has
  replaced it are dropped: the first is logged, and the client's disconnect
  line counts them. A command admitted while its client was current still
  finishes, with its answers dropped. Both mattered on runtimes with Node's
  socket semantics, such as Bun 1.4.2. There a reset socket stayed current,
  so telemetry kept going to it until the next client connected, and only a
  socket error was logged, never the disconnect. A superseded client's
  `subscribe` replaced the new client's filter, its `text` reached the agent,
  whose output then went to the new client, and its other commands ran, with
  the answers `reply()` sends dropped. Bun 1.3.14 gives a reset socket an
  `end` and closes a superseded socket whole, so neither happened there.
- A fleet parent lets go of a child's socket at its `close` as well as its
  `end`. After a reset with no `end` (on Bun 1.4.2, a child that died with
  the parent's commands unread), the fleet's requests to that child, such as
  `requestDescribe`, report it unreachable instead of writing into the dead
  socket. A spawned child's exit already let go of it; an adopted child has
  no exit event to.
