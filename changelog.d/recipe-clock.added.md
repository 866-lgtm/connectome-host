- Recipe `agent.clock` (off when omitted) turns on agent-framework's clock
  rows: `{ "intervalMinutes": 10 }` (or `intervalSeconds`, with optional
  `precision: "minutes" | "seconds"`) writes a `Clock: 10:50 Europe/Berlin
  (UTC+02:00)` row, in `agent.timezone`, whenever a boundary of that interval
  has passed: before an incoming message, at a turn's start, and mid-turn
  after a tool round's results. Validated at recipe load with the
  framework's own rules, naming the key. Needs agent-framework with
  `AgentConfig.clock`.
