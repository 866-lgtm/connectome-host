- A TUI host asked to stop by a signal now stops as `/quit` does: it puts the
  terminal back, stops the framework, and exits 0, or 1 if the stop fails. That
  holds for SIGTERM, which the Web UI's own quit sends, for SIGINT and SIGHUP,
  and for its terminal going away. When the lost terminal's error reaches the
  host before its stop ends, `tui-error.log` names that error. Before, the host
  exited 1 within a second, without stopping the framework. While the stop
  runs, a further SIGTERM, SIGINT or SIGHUP joins it rather than ending the
  process.
- `/quit` in a TUI host with the Web UI loaded now ends the process. Before, the
  framework stopped but the web server kept the process running.
- A session switch, from the TUI or the Web UI, that is under way when a TUI
  host stops no longer leaves a framework running: one it makes after the
  stop began is stopped rather than installed, and the Web UI's server,
  which making it opens again, is closed. A switch that hasn't begun making
  one by then makes none. Either way the host still ends; after a stop that
  succeeds, it ends once a making under way has settled.
