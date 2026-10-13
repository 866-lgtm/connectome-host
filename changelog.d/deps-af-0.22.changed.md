- Depend on released `@animalabs/agent-framework` 0.22.0,
  `@animalabs/context-manager` 0.14.0 and `@animalabs/membrane` 0.5.87.
  - **Prompt cache, once:** agent-framework 0.22's workspace tools (`ls`,
    `glob`, `grep`, `sync`, `materialize`, `delete`) have new descriptions and
    parameters, so the first request after the upgrade misses the cache from
    its tool block on.
  - **Workspace:** listings report what is on disk, `sync` without a path no
    longer replaces a workspace draft, and `materialize` no longer overwrites a
    file another writer changed (agent-framework 0.22's changelog has the
    details).
  - **Stores:** under `kv-unified`, context-manager 0.14 stores its
    presentation receipt run-length encoded, so `records.log` no longer grows
    quadratically with session length. Stores written by 0.13 still load.
  - **Makeup panel:** a native agent's exact count now carries its
    `prefillUserMessage` as the synthetic leading user turn, because membrane
    0.5.87's native formatter sends it there (it used to send `[continuing]`).
