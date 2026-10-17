- The `mcpl-admin` tools' errors say whether anything changed and what to do
  next, and every result, receipts and `mcpl_list` lines included, names the
  tools the way the agent calls them (`mcpl-admin--mcpl_deploy`), so a
  remedy can be followed as written. The tool descriptions are unchanged but
  for one sentence in `mcpl_deploy`'s: a deploy replaces the server's entry
  whole, so each of its fields goes in every time.
  - A call that fails says whether it changed anything: nothing, or that it
    stopped partway, from the call's own record of its changes.
  - An agent overlay that can't be read stops only the calls that need it.
    Before, it stopped `mcpl_list`, a session-only `mcpl_unload` and every
    other call but a restart. A deploy and an unload that would record
    itself are refused, and the unload's refusal points a loaded server to
    `persist: false`. `mcpl_list` lists the servers, with the sources the
    overlay decides as unknown, and an unload for this session of a server
    that's loaded, or the operator's, goes on. A restart goes on too, and
    its note says that a deploy, and an unload that persists, are refused
    meanwhile. Each tool says it in one wording, an unload that can't read
    the file when it reads it again after the disconnect included: why the
    file can't be read, that the next host start will stop on it, and the
    repair. For a file that isn't valid JSON or holds `null`, the start
    stops until it's fixed, and the repair is to fix it (or have the
    operator fix it), with why not to move it aside. For one that can't be
    opened or read, such as a directory in its place, the start stops while
    it can't be read, and the repair goes by whose failure it is: too many
    files open (`EMFILE`, `ENFILE`) is the host's own and can pass, so the
    call is made again shortly, then the operator asked; any other code is
    the file's, for the operator to fix. The listing's line for an
    operator's `mcpl-servers.json` it can't read gives the same repair, and
    says once that what the list says a start loads holds once a start gets
    past that file, if the file still defines what it did at this host's
    start. Before, a deploy passed the file-system error on with no step.
    The boot, which stops on such a file, keeps its operator message.
  - `mcpl_deploy` names every problem with its arguments in one refusal,
    where it named only the first, so an agent fixes them in one call: an
    argument the tool doesn't take, the id, the command or url, an `access`
    grant the host can't serve, each malformed field, a url that isn't
    `ws://` or `wss://`, and a tool prefix a module or another server holds.
    A credential it would send over `ws://` to another machine is refused
    after that, once the url is known to be valid.
  - `mcpl_deploy`, `mcpl_restart` and `mcpl_unload` now refuse an argument
    they don't take, naming it beside the arguments they take. An agent
    that copies a url entry from its overlay sends `transport`, which
    `mcpl_deploy` writes into each url entry it saves but sets itself.
    `mcpl_unload` also refuses a `persist` given as anything but true or
    false (`null` leaves the default in a tool call, as an unspecified
    field does in a deploy; through `utils`, agent-framework refuses a
    `null` for a true-or-false field before the module sees it). Before,
    such an argument was dropped and the call went on
    without it, and any `persist` but `false` counted as true. So a
    misspelled `disabledTools` left the server with no deny-list, a
    `command` given to a restart left the server running its old one while
    the reply said it had restarted, and a misspelled `persist: false`, or
    `persist: "false"`, made an unload meant for this session persist, with
    nothing said. A restart given one of `mcpl_deploy`'s arguments is
    pointed to a deploy.
  - A url that isn't `ws://` or `wss://`, and a tool prefix that a module,
    a server loaded now, or a server the next host start configures holds,
    are refused before anything is saved. Before, such a url was saved,
    and with reconnect, a url's default, retried in the background while
    the reply said it kept retrying; such a prefix was saved, the connect
    failed, and the next host start stopped on it. An env value JSON can't
    write (`Infinity`, `NaN`), which would have been saved as `null`, is
    refused too.
  - A deploy whose overlay can't be saved names the file, which an error
    from the write itself doesn't, and says no server was connected or
    restarted, and, when the save failed before writing anything, that
    nothing was deployed, with the repair by whose failure it is, as for a
    read. For a save that may have stopped partway (a full disk, say, or any
    failure not known to come before the write), it says what the file holds
    isn't known (its old content, the new content whole, or the new content
    cut short), that `mcpl_list` shows the entries it holds or why it can't
    be read, and that the next host start stops on a file that isn't valid
    JSON. Before, the raw file-system error came through. An unload whose
    record fails that way says the same.
  - A failed connect or restart says the state agent-framework left the
    server in, read rather than guessed: still running its previous
    configuration, no longer loaded (so `mcpl_restart` can't reach it), or
    loaded but down. A restart that leaves the id unloaded gives the step
    that a restart of an unloaded id gives, by what defines it; a deploy
    that does says its entry is saved and loads at the next host start. A
    server of the agent's own that a restart leaves down is pointed to a
    deploy for a wrong command, args or url, with each of its fields, since
    a deploy replaces the entry whole, and to a restart only once the server
    itself is fixed, since a restart reconnects with the configuration of
    its last connect, whether that connect succeeded or not. One the
    operator defines is pointed to the operator for a wrong command, args or
    url, since its args and env aren't shown to the agent and a deploy would
    replace their definition whole; and, with the overlay unreadable, the
    deploy waits until the file can be read. For a server the operator also
    defines, which definition it runs isn't known while the overlay can't be
    read, so the step for each is given, and `mcpl_list` shows which once
    the file can be read; that's so too for one such a restart left
    unloaded. One that a deploy's failed connect or restart leaves down is
    pointed to a deploy again, which applies the saved entry whichever
    configuration the framework holds.
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
  for such a file changes accordingly. `mcpl_list`, which failed on such a
  file, now lists the servers, with the sources the file decides as
  unknown, and says that the next host start will stop on the file before
  it loads any server, that the file is the operator's to fix, and that
  only the listing reads it.
- An overlay entry that names no command and no url is logged at the boot
  as "it names no command to run and no url to dial", in place of "it names
  nothing to run or dial".
