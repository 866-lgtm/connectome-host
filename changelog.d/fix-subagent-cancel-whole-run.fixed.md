- Cancelling a subagent, or all of them with Esc, now reaches one still
  waiting for a concurrency slot, which leaves the queue and never starts,
  one still setting up an attempt, which ends there, even if its setup
  would never finish, and one between attempts, in the back-off before a
  retry or in a rate limit's cooldown, which ends there instead of
  retrying. Cancelling a subagent also reaches its children, those still
  waiting for a slot and those an earlier attempt of it spawned, and the
  interrupt's "N subagent(s) stopped" counts each subagent it stopped
  once, a child stopped through its parent included. Before, a cancel
  reached a subagent only mid-attempt: a queued one started anyway once a
  slot freed, and one between attempts went on to retry. A stuck
  subagent's slot reclaimed between attempts now ends it too, where its
  next attempt used to run without a slot.
- A subagent's retry reports its own result, where it used to report one
  that an earlier attempt returned with `return` before it failed.
