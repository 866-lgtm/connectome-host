- The Web UI's alert strip clears a `compression-quarantine` or
  `inference-exhausted` row once its agent leaves the `/healthz` snapshot, as
  a spawned or forked subagent does when it is torn down. Before, the row
  stayed until the page was reloaded, and a quarantine row looks like an
  outage.
