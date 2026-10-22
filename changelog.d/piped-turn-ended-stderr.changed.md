- Piped mode (`--no-tui`, or a batch run whose stdin isn't a TTY) now prints
  `(turn ended: <error>)`, its line for a turn agent-framework ended as a
  failure, on stderr, beside its `Error:` lines. It printed it on stdout
  before, among the agent's answer, so a script that read that line from
  stdout finds it on stderr now.
