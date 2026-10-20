- A session switch goes on when the current session's framework stops but
  reports a failed teardown. From agent-framework 0.23.0, `stop()` rejects
  after its whole teardown when an MCP server's child couldn't be confirmed
  exited, and a switch from the TUI, the Web UI or a piped command ended
  there: the old session's framework was stopped and no new one started, so
  the agent was gone until the host restarted. The rejection, which names
  each such child, is now logged, and the new session starts.
