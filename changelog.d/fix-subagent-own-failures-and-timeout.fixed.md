- The `subagent` module no longer retries a subagent because a word in its
  name or a number in its error looks transient. Before, the module's own
  failures went through the same word checks as a provider's, name and
  numbers included: a prompt over the limit for a subagent named `migrate`
  (which holds "rate") counted as a rate limit, so the module halved its
  concurrency, waited 30 s and ran the subagent again; one named
  `idle-watch` was run again; and a time limit whose milliseconds hold
  "500", such as 1500, was retried from the start. The module's own failures
  now end at once. A framework failure is read without the ephemeral agent's
  name, status codes count only as whole numbers, so a watchdog's "15000ms"
  is no HTTP 500, and a rate limit is read from its phrases ("rate limit",
  "rate exceeded", "too many requests") or its status, so "generate",
  "rated" or "too many tokens" in a provider's error no longer counts as
  one, which halved the concurrency and ran the subagent again.
- A sync subagent still running at its `timeoutMs` (by default the module's
  `maxExecutionMs`, 600 s) now moves to the background, as the tools' schema
  says: the call answers that it moved, and the run goes on and delivers its
  result as a message when it ends. Before, without `timeoutMs` the call
  answered "timed out" at 600 s and the result was dropped; with it, the
  call answered that the run had moved to the background, and a moment later
  it was reported timed out while it went on untracked. **Agents:** a sync
  subagent at its mark now answers "moved to background", and its result
  arrives later as a message.
- An async subagent's `timeoutMs` is now a hard limit on its whole run,
  counted from when it holds a concurrency slot, retries and the cooldown
  after a rate limit included, and the run is stopped there. A run whose
  inference hasn't started by then is dropped by the framework, and one
  whose setup outlasts the limit isn't started; both are reported as the
  time limit. Before, each attempt got the full limit, with its back-off
  outside it, so an attempt that failed with a retryable error 50 s into a
  60 s limit was retried with a fresh 60 s, and the run could last 115 s;
  and at the limit the module stopped waiting while the run went on, tools
  included, with nothing tracking it and its result dropped. A tool call
  already running at the limit finishes, and its result is dropped.
- `subagent--concurrency` with a higher `maxConcurrent` now raises the
  effective limit too, so spawns waiting for a slot start at once. While a
  rate limit holds the effective limit down, it recovers toward the new
  ceiling after successes, and the answer says so. Spawns waiting for a slot
  now also start when successes raise the limit or a stuck subagent's slot
  is reclaimed, and a reclaimed slot is no longer released twice, which let
  more subagents run at once than the limit allowed. A stuck spawn is now
  reclaimed even when a finished fork had its name, and the other way round;
  a run whose agent couldn't be created no longer shows as running, and a
  run that fails while it's being registered releases its slot, which before
  stayed held until the host restarted.
- A `timeoutMs` longer than about 24.8 days no longer takes effect at once:
  it's taken as about 24.8 days, the longest a timer waits.
