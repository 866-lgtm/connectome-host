- The `mcpl-admin` tools' errors say whether anything changed and what to
  do next, and every result, receipts and `mcpl_list` lines included, names
  the tools the way the agent calls them (`mcpl-admin--mcpl_deploy`), so a
  remedy can be followed as written. The tool descriptions are unchanged.
  - A call that fails before it changes anything says so. When the agent
    overlay isn't valid JSON, or holds `null`, the agent is told in its own
    terms, with how to repair the file and why not to move it aside. The
    boot, which stops on such a file, keeps its operator message.
  - A deploy whose overlay can't be saved says nothing was deployed, and
    connects nothing. Before, the raw file-system error came through, and
    nothing said the server wasn't connected.
  - `mcpl_restart` of an id that isn't loaded is refused before
    agent-framework is asked, naming the loaded servers and why the id isn't
    one of them, in place of agent-framework's "MCPL server … is not
    configured". `mcpl_unload` of an unknown id names the loaded servers too.
  - A tool name the module doesn't have is answered with the tools it does
    have, or its utilities when the recipe sets `surface: "utilities"`.
- A `mcpl-servers.json` that isn't valid JSON is named by its path in the
  error. Before, JSON.parse's own message came through, which names no file
  and can quote the file's text, credentials included. Operators see it from
  `/mcp` and the web UI's MCPL edits, and the agent from `mcpl_list`, which
  now also says the other three tools don't read that file.
