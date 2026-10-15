- The `identity` utilities' errors say whether anything was sent and what to
  do next, naming the utilities the way the agent runs them
  (`identity--accept_invite`, through `utils`).
  - `request` with `fromFile` sends the workspace's copy of a file only when
    disk has no file at that path: one the resident wrote through the
    workspace and never materialized, or one whose mount's directory is gone.
    Before, any failed disk read fell back to the workspace's copy, so a file
    over the 64 MiB upload limit on disk, or one that couldn't be read there,
    went out as whatever older or different copy the workspace held, and
    nothing said so. Such a file is now refused with disk's reason. The
    upload receipt's new `from` says which copy went, and every successful
    upload carries the receipt, including one whose response was saved with
    `saveAs` or was binary.
  - `request` with `saveAs` and no workspace is refused before anything is
    sent. Before, the request went out and only then failed to save, so a
    write's answer was lost.
  - A response that `saveAs` stored in the workspace, with only its copy on
    disk failed, counts as saved, as agent-framework's `save_recent_image`
    counts such a file, and the receipt's new `saved.diskCopyError` gives
    the reason. Before, the agent read that the response couldn't be saved,
    and could send a write again for it.
  - A write's binary response that isn't saved no longer advises repeating
    the request with `saveAs`, which would send the write again. It says to
    pass `saveAs` with the write itself; a GET's note is unchanged.
  - A `request` that got no reply says its outcome is unknown, and to check a
    write before sending it again. One whose reply came back but couldn't be
    read or saved says it went through, with the status. Before, both read
    "<service> request failed".
  - The identity service's refusals of access and of registration are
    worded by their status: a 429 or 5xx says to try again shortly, and any
    other says calling again won't change it. A registration the service
    accepted but this host couldn't record, and one that got no reply, each
    say what happened and what to do. Before, both surfaced as raw errors.
  - The messages about access are written for both their readers, the agent
    (through `request` and an MCPL deploy's connect failure) and the
    operator (the dial's log), without the `identity:` prefix.
