- A peek at a subagent, and a fork's read of its parent's context, now
  compile that context dry. Each compiled it for real, which commits fold
  resolutions and chunk records and queues compression, though nothing sends
  that compile. By context-manager's contract, a dry compile gives the same
  messages and commits nothing, apart from releasing a compression hold past
  its deadline, as any compile does. Its one other difference is that it
  returns a plan over budget where a real compile refuses it. These reads
  compile at context-manager's default budget, so for a context whose plan
  is over it, a peek now shows the plan's message count and last message,
  where it showed none, and a fork now goes ahead from its parent's plan,
  where it failed, if its own launch check, still a real compile, passes.
