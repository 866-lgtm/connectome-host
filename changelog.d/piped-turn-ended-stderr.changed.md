- Piped mode (`--no-tui`, or a batch run whose stdin isn't a TTY) now prints
  `(turn ended: <error>)`, its line for a turn agent-framework ended as a
  failure, on stderr beside its `Error:` lines, for any agent's turn. It
  printed it on stdout before, among the agent's answer, and only for the
  primary agent's turn, so a script that read that line from stdout finds it
  on stderr now. When a turn's end goes to stderr, piped mode now also ends
  the agent's line on stdout, where what came next, such as a batch's echo of
  its next line or `Done.`, used to follow on the same line; the `Error:` and
  `(turn ended: …)` lines on stderr no longer begin with a line break.
