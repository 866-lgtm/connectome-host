- **Scripts driving piped mode:** in piped mode (`--no-tui`, or a batch run
  whose stdin isn't a TTY), the line for a turn agent-framework ended as a
  failure, `(turn ended: <error>)`, now prints on stderr, beside the
  `Error:` lines, for any agent's turn. It printed on stdout before, among
  the agent's answer, and only for the primary agent's turn. A script that
  looked for it on stdout reads stderr for it now. Unchanged: the agent's
  prose and a stop's `(turn aborted: <reason>)` stay on stdout, and `Error:`
  lines stay on stderr.
