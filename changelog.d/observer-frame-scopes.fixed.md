- A Web UI observer now gets only what its grant's scopes cover, live as
  well as when it connects.
  - **The host's traces** are each sent by what they carry. Tool calls,
    their results, and what an agent takes in (`process:` traces) need
    `messages` and `tools`; thinking deltas `messages` and `thinking`; a
    turn's end, which carries token counts, `messages` and `health`; usage
    and the serving state (`host:` traces) `health`; failures, refusals,
    the gate's decisions, module changes and `operator:action` `ops`; and
    `mcpl:speech-routed`, which carries the routed text, `messages` and
    `ops`. A trace type the host doesn't classify goes to operators alone.
  - **A new `stream-ended` frame,** `{ type: 'stream-ended', agentName }`,
    goes to a client that holds `messages` in place of a stream-end trace
    it may not have: `inference:failed` or `inference:exhausted` without
    `ops`, and `inference:completed` without `health`. It says only whose
    stream ended, and the Web UI ends the streamed turn on it as on the
    trace. A client of the protocol other than the Web UI should do the
    same.
  - **A child's events** go by the same rules. Its lifecycle needs
    `health`, its agent tree every scope but `debug`, and its speech
    `messages` and `thinking`. An operator's command output in a child,
    and any kind the host doesn't classify, go to operators alone.
  - **Other live frames:** an incoming message's excerpt and a branch
    change need `messages`, and the serving state `health`. Pins and
    context settings go to operators alone.
  - **The welcome:** without `messages`, it leaves out the session's and
    the branch's names and keeps their ids, since an auto-named session's
    name summarizes the conversation. Without `health`, it leaves out the
    serving state and each agent's model. The agent trees, whose nodes
    say how each run ended, go only to an observer granted every scope
    but `debug`.

  An operator's connection is unchanged.
