- The Web UI's alert strip clears a `compression-quarantine` or
  `inference-exhausted` row it raised from `/healthz` for an agent once that
  agent leaves the snapshot, as a spawned or forked subagent does when it is
  torn down. Before, the row stayed until the page was reloaded, and a
  quarantine row looks like an outage. A row whose agent's quarantine read
  failed (`readFailures`) stays, and rows that live alerts raised keep their
  own lifecycle.
