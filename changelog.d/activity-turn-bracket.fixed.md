- The `activity` module now counts a turn as over at `inference:turn_ended`
  (a turn a tool ended) and `inference:aborted` too, as well as at its
  other ends. Before, after such a turn it still counted one as under way,
  so a channel added with `show_in` started showing "typing…" with nothing
  composing. A silent wake, whose prose is suppressed, no longer turns the
  indicator on, as agent-framework's own Discord module doesn't. The module
  also stops listening to the framework's traces when it stops.
