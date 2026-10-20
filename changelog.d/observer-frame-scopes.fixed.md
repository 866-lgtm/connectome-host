- A Web UI observer now gets only what its grant's scopes cover, live as
  well as when it connects. The Web UI's protocol version is now 2, so a
  page left open from before the update asks to be reloaded.
  - **The host's traces** are each sent by what they carry. Tool calls
    and their results need `messages` and `tools`, and a failed or dropped
    call, or one an operator made for the agent, `ops` as well; thinking
    deltas `messages` and `thinking`; a turn's end, which carries token
    counts, `messages` and `health`; a stopped turn, whose reason says
    where it was stopped from, `messages` and `ops`; usage and the serving
    state (`host:` traces) `health`; failures, refusals, the gate's
    decisions, module changes, held speech's delivery and what operators
    did `ops`; the `process:` traces, which carry whole events and modules'
    own payloads, every scope but `debug`; and `mcpl:speech-routed`, which
    carries the routed text, `messages` and `ops`. A trace type the host
    doesn't classify goes to operators alone.
  - **A new `stream-ended` frame,** `{ type: 'stream-ended', agentName }`,
    goes to a client that holds `messages` in place of a stream-end trace
    it may not have: `inference:failed`, `inference:exhausted` or
    `inference:aborted` without `ops`, and `inference:completed` without
    `health`. For a fleet child's stream it comes inside a `child-event`.
    It says only whose stream ended, and the Web UI ends the streamed turn
    on it as on the trace. A client of the protocol other than the Web UI
    should do the same.
  - **A child's events** go by the same rules. Its lifecycle needs
    `health`, its agent tree every scope but `debug`, and its speech
    `messages`, `thinking` and `tools`. An operator's command output in a
    child, and any kind the host doesn't classify, go to operators alone.
  - **Other live frames:** an incoming message's excerpt and a branch
    change need `messages`, and the serving state `health`. Pins and
    context settings go to operators alone.
  - **The welcome:** without `messages`, it leaves out the session's and
    the branch's names and keeps their ids, since an auto-named session's
    name summarizes the conversation. Without `health`, it leaves out the
    serving state and each agent's model. The agent trees, whose nodes
    say how each run ended, go only to an observer granted every scope
    but `debug`. The Web UI's scope picker lists children from the trees, so
    a grant without them no longer has it; `/healthz?scope=` still
    answers a grant that holds `health`.
  - **The page:** it shows the agent tree only to an operator or an
    observer granted every scope but `debug`, and tells another observer
    so in the tree tab. A tool call whose result has loaded shows failed or
    done by that result, so a page that doesn't get `tool:failed` still
    shows a failed call as failed.

  An operator's connection is unchanged.
