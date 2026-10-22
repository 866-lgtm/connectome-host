- Piped mode (`--no-tui`, or a batch run whose stdin isn't a TTY) now prints
  `(turn ended: <error>)`, its line for a turn agent-framework ended as a
  failure, on stderr beside its `Error:` lines, for any agent's turn. It
  printed it on stdout before, among the agent's answer, and only for the
  primary agent's turn, so a script that read that line from stdout finds it
  on stderr now. At a failure, piped mode now ends the agent's line on stdout
  before its line on stderr, where what came next, such as a batch's echo of
  its next line or `Done.`, used to follow on the same line; the `Error:` and
  `(turn ended: …)` lines on stderr no longer begin with a line break, so in
  a terminal showing both the line breaks fall as before. Where stdout's line
  had already ended, as after a tool's line, stdout now gets an empty line
  there, and a retried attempt's answer can start after a blank line.
