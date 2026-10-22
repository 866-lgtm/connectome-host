- A recipe's workspace mount takes agent-framework 0.24's `backend` and
  `include`. `backend: "direct"` reads disk's own copy as it is, with no
  store, scan or watcher, for a checkout an agent reads; a mount whose store
  still holds changes from when it ran as Chronicle runs as Chronicle until
  they're settled, as agent-framework says at start. `include` lists what a
  mount holds, as names, `*.ext` globs and `dir/**` globs. Before, a recipe
  that gave either stopped loading, as a key a mount doesn't have.
- A direct mount that gives no `mode` is read-only, the host's default
  there and the only mode agent-framework takes on a direct mount. Other
  mounts are still read-write by default.
- What agent-framework refuses in a recipe's mounts, such as a `watch`
  other than `"never"`, `wakeOnChange` or `autoMaterialize` on a direct
  mount, or an `include`
  pattern it can't read, stops the recipe loading in the framework's own
  words, naming the mount, so a refused recipe is never saved to resume.
- The host's `_config` mount says its backend, `"chronicle"`, which its
  undo and redo need, whatever the framework's default (as antra-tess
  proposed in #241).
