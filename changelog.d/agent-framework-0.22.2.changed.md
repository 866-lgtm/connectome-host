- Requires `@animalabs/agent-framework` ^0.22.2 (with `@animalabs/context-manager` 0.14.1).
  On 0.22.1, a kv-unified agent that had saved a budget below its configured one failed to
  start: the boot restore applied it as a paced decrease, which kv-unified refuses, and the
  error escaped `AgentFramework.create()`. 0.22.2 keeps a setting it can't apply at boot set
  but unapplied, and says so on stderr.
