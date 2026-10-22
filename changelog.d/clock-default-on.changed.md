- **Operators:** every agent now gets clock rows every ten minutes unless its
  recipe says otherwise. A recipe without `agent.clock` gets
  `{ "intervalMinutes": 10 }` (`DEFAULT_RECIPE_CLOCK`), so after the upgrade a
  resident's window takes a `Clock: …` row at its next event or turn start and
  then once each ten-minute boundary has passed, mid-turn after a tool round's
  results included. On some models a clock after a tool's results drops the
  loop's earlier thinking from the request, at most once an interval.
  **Migration:** to keep an agent without clock rows, set `agent.clock: false`;
  to change the interval, give `agent.clock` one of its own. **Unchanged:**
  subagent streams take no clock rows, and a recipe that already sets
  `agent.clock` gets what it sets.
