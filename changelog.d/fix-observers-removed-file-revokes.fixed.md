- Removing `observers.json` now takes every grant in it away within about 6
  s, once two of the web viewer's checks in a row find it gone, and the
  viewer's log says so, with why the file can't be read when it's there but
  unreadable. A file back by the second check, as after an editor's save
  that removes it before writing it, changes nothing. Before, a running
  viewer went on admitting a hello from every grant it had held until it
  restarted, while the `observers` tools already read a missing file as no
  grants. With no grants left, the static app shell needs the password
  again, as on a host that never had the file, and the sessions and open
  connections the file's grants gave end with them. A file put back is read
  again at the next check, and so is one replaced by a file with the same
  mtime, or made unreadable in place, which the viewer used to take for
  unchanged.
