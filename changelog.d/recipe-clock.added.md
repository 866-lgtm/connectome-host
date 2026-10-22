- Recipe `agent.clock` (off when omitted) turns on agent-framework's clock
  rows: `{ "intervalMinutes": 10 }` (or `intervalSeconds`, with optional
  `precision: "minutes" | "seconds"`) writes a `Clock: 10:50 Europe/Berlin
  (UTC+02:00)` row, in `agent.timezone`, whenever a boundary of that interval
  has passed: before an incoming message, at a turn's start, and mid-turn
  after a tool round's results, except on the `anthropic-xml` formatter.
  Subagent streams take none, and a fork's start orientation names its clock
  rows as off beside its parent's. Validated at recipe load with the
  framework's own rules, naming the key; a key the framework doesn't take is
  refused. Needs agent-framework 0.24.1, which the host now requires.
