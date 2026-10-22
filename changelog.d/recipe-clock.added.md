- Recipe `agent.clock` (off when omitted) turns on agent-framework's clock
  rows: `{ "intervalMinutes": 10 }` (or `intervalSeconds`, with optional
  `precision: "minutes" | "seconds"`) writes a `Clock: 10:50 Europe/Berlin
  (UTC+02:00)` row, in `agent.timezone`, whenever a boundary of that interval
  has passed: before an incoming message, at a turn's start, and mid-turn
  after a tool round's results, except on the `anthropic-xml` formatter. On
  some models a clock after a tool's results drops the loop's earlier
  thinking from the request, at most once an interval. Subagent streams take
  none: a subagent's start orientation lists its clock rows as off and,
  where it has a parent or calling stream, that stream's setting beside them.
  Validated at recipe load with the framework's own rules, naming the key; a
  key the framework doesn't take is refused.
