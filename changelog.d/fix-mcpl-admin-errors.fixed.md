- The `mcpl-admin` tools' errors say whether anything changed and what to
  do next, and every result, receipts and `mcpl_list` lines included, names
  the tools the way the agent calls them (`mcpl-admin--mcpl_deploy`), so a
  remedy can be followed as written. The tool descriptions are unchanged.
  - A call that fails says whether it changed anything: nothing, or that it
    stopped partway, from the call's own record of its changes. When the
    agent overlay isn't valid JSON, or holds `null`, the agent is told in
    its own terms, with how to repair the file (or have the operator repair
    it) and why not to move it aside, on every tool's path. The boot, which
    stops on such a file, keeps its operator message.
  - `mcpl_deploy` names every problem with a call in one refusal, where it
    named only the first, so an agent fixes them in one call: an argument
    the tool doesn't take, the id, the command or url, an `access` grant the
    host can't serve, each malformed field, a url that isn't `ws://` or
    `wss://`, and a tool prefix a module or another server holds.
  - `mcpl_deploy` now refuses an argument it doesn't take, naming it beside
    the arguments it takes. Before, the argument was dropped and the deploy
    went on without it, so a misspelled `disabledTools` left the server
    with no deny-list and nothing said.
  - A url that isn't `ws://` or `wss://`, and a tool prefix that a module
    or another server holds, now or at the next host start, are refused
    before anything is saved. Before, such a url was saved, and with
    reconnect, a url's default, retried in the background while the reply
    said it might still connect; such a prefix was saved, and the next host
    start stopped on it. An env value JSON can't write (`Infinity`, `NaN`),
    which would have been saved as `null`, is refused too.
  - A deploy whose overlay can't be saved says nothing was deployed and no
    server was connected or restarted. For a write that may have stopped
    partway (a full disk, say), it says what the file holds isn't known
    (its old content, the new content whole, or a mix cut short), that
    `mcpl_list` shows which, and that the next host start stops on a file
    that isn't valid JSON. Before, the raw file-system error came through.
    An unload whose record fails that way says the same.
  - A failed connect or restart says the state agent-framework left the
    server in, read rather than guessed: still running its previous
    configuration, no longer loaded (so `mcpl_restart` can't reach it), or
    loaded but down. A restart that leaves the id unloaded gives the step
    that a restart of an unloaded id gives, by what defines it; a deploy
    that does says its entry is saved and loads at the next host start. A
    server a restart leaves down is pointed to a deploy for a wrong command,
    args or url, and to a restart only once the server itself is fixed,
    since a restart reconnects with the configuration it last connected
    with; one a deploy leaves down is pointed to a deploy again, which
    applies the saved entry whichever configuration the framework holds.
  - `mcpl_restart` of an id that isn't loaded is refused before
    agent-framework is asked, naming the loaded servers and the next step by
    what defines the id: the agent's overlay, the operator, or nothing. It
    replaces agent-framework's "MCPL server … is not configured".
    `mcpl_unload` of an unknown id names the loaded servers too.
  - The advice for a tombstoned server the operator defines routes the
    tombstone's removal to the operator for an agent that can't edit the
    file, and says it takes effect at the next host start.
  - After the module stops, at shutdown or a session switch, each tool says
    the tools have stopped, without advice to retry.
  - A tool name the module doesn't have is answered with the tools it does
    have, or its utilities when the recipe sets `surface: "utilities"`.
  - `mcpl_list` with nothing loaded and nothing in the overlay says no
    server is loaded, where it said none was configured.
- A `mcpl-servers.json` that isn't valid JSON is named by its path in a
  `SyntaxError` that never quotes it, at the boot as well as in `/mcp`, the
  web UI's MCPL edits and `mcpl_list`; one whose root is `null` is named in
  a `TypeError`. Before, JSON.parse's own message came through, which names
  no file and can quote the file's text, a token in an env block included,
  and a `null` root threw a `TypeError` naming nothing. The boot's message
  for such a file changes accordingly. `mcpl_list` also says the other
  three tools don't read that file.
- An overlay entry that names no command and no url is logged at the boot
  as "it names no command to run and no url to dial", in place of "it names
  nothing to run or dial".
