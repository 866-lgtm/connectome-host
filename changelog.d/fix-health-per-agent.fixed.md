- The health snapshot (`/healthz` and the `health` panel op) reads each agent
  on its own in its per-agent sections: `compressionQuarantine`,
  `compressionDebt`, `contextComposition` and `runtimeSettings`. Before, one
  agent whose read threw dropped the whole section for every agent, which
  happened to `contextComposition` and `runtimeSettings` while an agent's
  context manager wasn't initialized, as after a store surgery. Now that agent
  is left out of the section, and the snapshot's new `readFailures` names it,
  by section, with the error's message. The Web UI's health panel shows those
  failures, so a failed compression-debt read no longer reads as "not
  reported by this stack".
