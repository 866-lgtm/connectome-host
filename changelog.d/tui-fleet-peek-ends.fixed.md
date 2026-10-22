- A fleet child's peek in the TUI shows each end of a turn as a subagent's
  peek does. A turn agent-framework ended as a failure reads
  `✗ turn ended: <error>`, with its error, where it read
  `· inference:exhausted`; an aborted turn reads `✗ turn aborted: <reason>`,
  and one a tool ended reads `── turn ended by a tool ──`.
