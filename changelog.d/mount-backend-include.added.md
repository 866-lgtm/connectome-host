- A recipe's workspace mount takes agent-framework 0.24's `backend` and
  `include`. `backend: "direct"` reads disk's own copy as it is, with no
  store, scan or watcher, for a checkout an agent reads; a mount whose store
  still holds changes from when it ran as Chronicle runs as Chronicle until
  a start after they're settled, and agent-framework says at start how to
  settle them. A direct mount that
  names no `ignore` passes over `node_modules`, `.git`, `dist`, `build`,
  `coverage`, `target`, `__pycache__` and `.venv`, and one that names any
  passes over only what it names. `include` lists what a
  mount holds, as names, `*.ext` globs and `dir/**` globs. Before, a recipe
  that gave either stopped loading, as a key a mount doesn't have.
- A direct mount names `mode: "read-only"`, the only mode agent-framework
  takes on a direct mount, and one that names no mode stops the recipe
  loading, saying so. A mount the agent writes, or whose changes should wake
  it, leaves `backend` out. Other mounts are still read-write by default.
- What agent-framework refuses in a recipe's mounts, such as a `watch`
  other than `"never"`, `wakeOnChange` or `autoMaterialize` on a direct
  mount, or an `include`
  pattern it can't read, stops the recipe loading in the framework's own
  words, naming the mount, so a refused recipe is never saved to resume.
- The host's `_config` mount says its backend, `"chronicle"`, which its
  undo and redo need, whatever the framework's default (as antra-tess
  proposed in #241).
