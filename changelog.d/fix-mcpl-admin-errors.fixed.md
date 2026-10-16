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
  - `mcpl_deploy` names every problem with its arguments in one refusal,
    where it named only the first, so an agent fixes them in one call: an
    argument the tool doesn't take, the id, the command or url, an `access`
    grant the host can't serve, each malformed field, a url that isn't
    `ws://` or `wss://`, and a tool prefix a module or another server holds.
    A credential it would send over `ws://` to another machine is refused
    after that, once the url is known to be valid.
  - `mcpl_deploy`, `mcpl_restart` and `mcpl_unload` now refuse an argument
    they don't take, naming it beside the arguments they take, and
    `mcpl_unload` refuses a `persist` given as anything but true or false
    (`null` leaves the default, as an unspecified field does in a deploy).
    Before, such an argument was dropped and the call went on without it,
    and any `persist` but `false` counted as true. So a misspelled `disabledTools`
    left the server with no deny-list, a `command` given to a restart left
    the server running its old one while the reply said it had restarted,
    and a misspelled `persist: false`, or `persist: "false"`, made an unload
    meant for this session persist, with nothing said. A restart given one
    of `mcpl_deploy`'s arguments is pointed to a deploy.
  - A url that isn't `ws://` or `wss://`, and a tool prefix that a module,
    a server loaded now, or a server the next host start configures holds,
    are refused before anything is saved. Before, such a url was saved,
    and with reconnect, a url's default, retried in the background while
    the reply said it kept retrying; such a prefix was saved, the connect
    failed, and the next host start stopped on it. An env value JSON can't
    write (`Infinity`, `NaN`), which would have been saved as `null`, is
    refused too.
  - A deploy whose overlay can't be saved says no server was connected or
    restarted, and, when the save failed before writing anything, that
    nothing was deployed. For a save that may have stopped partway (a full
    disk, say, or any failure not known to come before the write), it says
    what the file holds isn't known (its old content, the new content
    whole, or the new content cut short), that `mcpl_list` shows which, and
    that the next host start stops on a file that isn't valid JSON. Before, the raw
    file-system error came through. An unload whose record fails that way
    says the same.
  - A failed connect or restart says the state agent-framework left the
    server in, read rather than guessed: still running its previous
    configuration, no longer loaded (so `mcpl_restart` can't reach it), or
    loaded but down. A restart that leaves the id unloaded gives the step
    that a restart of an unloaded id gives, by what defines it; a deploy
    that does says its entry is saved and loads at the next host start. A
    server a restart leaves down is pointed to a deploy for a wrong command,
    args or url, and to a restart only once the server itself is fixed,
    since a restart reconnects with the configuration of its last connect,
    whether that connect succeeded or not. One that a deploy's failed
    connect or restart leaves down is pointed to a deploy again, which
    applies the saved entry whichever configuration the framework holds.
  - `mcpl_restart` of an id that isn't loaded is refused before
    agent-framework is asked, naming the loaded servers and the next step by
    what defines the id: the agent's overlay, the operator, or nothing. It
    replaces agent-framework's "MCPL server … is not configured".
    `mcpl_unload` of an unknown id names the loaded servers too.
  - The advice for a tombstoned server the operator defines routes the
    tombstone's removal to the operator for an agent that can't edit the
    file, and says it takes effect at the next host start.
  - After the module stops, each tool says the tools have stopped, without
    advice to retry.
  - A tool name the module doesn't have is answered with the tools it does
    have, or with its utilities on the `utilities` surface.
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
