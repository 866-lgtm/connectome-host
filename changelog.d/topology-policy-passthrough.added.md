- Recipes can set **`agent.strategy.topologyPolicy: "report" | "reject"`**
  (context-manager 0.12+ load-time store-topology audit). Under the library
  default `'reject'`, a store whose summary archive carries crossed ownership
  makes `ContextManager.open` throw `StoreTopologyError` and the agent cannot
  start; `'report'` opens it, logs the violations and flags them as critical
  compression debt, so a resident with known crossed summaries keeps running
  while a repair is pending. Malformed values fail at recipe load.
