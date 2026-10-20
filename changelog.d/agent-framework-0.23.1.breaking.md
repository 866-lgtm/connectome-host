- **Operators:** connectome-host now requires `@animalabs/agent-framework`
  ^0.23.1 (was ^0.22.4), whose 0.23.0 opens a new line with breaking
  changes. The ones a host's operators meet, in brief; agent-framework's
  0.23.0 notes give each in full:
  - **MCPL servers' revision:** the MCPL engine now requires
    `protocolVersion` `2024-11-05` back from `initialize`. A server that
    answers another revision, or none, is refused for good, with no
    reconnect, and raises an `mcpl-down` ops alert. A hand-written server
    that omits the field must add it.
  - **Tool prefixes:** two MCPL servers whose `toolPrefix`es meet, as `foo`
    and `foo--bar` do, are refused at startup, at a runtime connect and at a
    restart. Change one of the two prefixes, such as `foo-bar` for
    `foo--bar`.
  - **A server entry with both `command` and `url`** and no `transport` is
    refused before anything is spawned or dialed, where it was launched as
    stdio and the url ignored. Drop the field you don't use, or set
    `transport`.
  - **`codeExecution`:** the python interpreter that runs model-authored
    scripts no longer inherits the host's environment, only an allowlist
    (`PATH`, `HOME`, the locale, temp directories, CA bundles and proxy
    variables) and `codeExecution.env`, and it starts in its own runtime
    directory, which teardown removes. List a variable a script needs in
    `codeExecution.env`, which a recipe can `${VAR}`-substitute from
    `.env`, and give a file a script keeps an absolute path.
    `codeExecution.inheritEnv: true` restores the whole environment,
    provider keys included.
  - **Workspace mounts with symlinks inside them:** on a mount that doesn't
    set `followSymlinks: true`, a file reached through a symlinked directory
    inside the mount is no longer read, written or synced through the link,
    and a file the host reads from disk behind one, such as an
    instructions file, is refused with a refusal that names the link.
  - **Two agents with one name** in a config are refused before the store
    opens.
  - **Tool definitions change**, `code_execution`'s among them, so a
    resident misses the prompt cache once, from its tool block on, at its
    first request after the upgrade.
  - `refusalHandling.announceHumanTurns` is removed in the framework, which
    never read it. A recipe that still sets it starts as before, with the
    setting ignored.
  - Going back to connectome-host 0.10.x installs agent-framework 0.22.x
    from its lockfile. agent-framework's notes don't say whether 0.22.x
    opens a store 0.23 wrote; back the store up before upgrading.
