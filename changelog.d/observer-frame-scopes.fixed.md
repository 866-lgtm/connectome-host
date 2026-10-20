- A Web UI observer now gets only what its grant's scopes cover, live as
  well as when it connects. Now a child's trace needs
  what the parent's trace of its kind needs, its lifecycle and the fleet's
  usage need `health`, and its agent tree needs `messages`, `thinking` and
  `tools`. An incoming message's excerpt and a branch change need
  `messages`, and the serving state needs `health`. Pins, context
  settings, an operator's command output in a child, and any other frame
  go to operators alone. Without `messages`, the welcome leaves out the
  session's and the branch's names and keeps their ids, since an
  auto-named session's name summarizes the conversation; without
  `health`, it leaves out the serving state. An operator's connection is
  unchanged.
