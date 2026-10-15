- `identity--request` with `fromFile` sends only what the workspace mount
  allows. Before, a symbolic link inside a mount let an upload send a file
  from outside the mount to a configured service, since the disk read
  checked only the path's text and followed any link. Uploads now read
  through agent-framework's `readFileFromDisk`, which keeps the mount's
  `followSymlinks` policy (off unless the mount sets it) and reads only
  inside the mount. A link it refuses, a link leading out of the mount, a
  directory, or a file over the 64 MiB upload limit is refused, with nothing
  sent. The workspace's stored copy goes only for a file disk doesn't have.
  Operators running 0.10.2 or earlier should upgrade.
