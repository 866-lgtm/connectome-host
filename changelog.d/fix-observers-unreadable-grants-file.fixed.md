- The web viewer reads `observers.json` grant by grant. It admits exactly
  the grants it can use, and its log names each one it can't, by position
  and label: a grant with an unknown scope or no scopes, a key that isn't
  an `ed25519:` key of 32 bytes, an expiry that isn't a date, or a key an
  earlier grant already has. Before, one bad grant made a running viewer
  keep every grant it last read, including grants the same edit had
  removed, and a viewer that started on such a file admitted none. Only a
  file that isn't valid JSON, which may be a save read halfway, still keeps
  the previous grants until it parses; a viewer that starts on one admits
  none until then. A file that's there but can't be read or checked, or
  isn't a grants file, admits none. The viewer reads a file that wasn't
  valid JSON, or couldn't be read, again at each check, and names the
  problem once.
- A key is the same key in either base64 alphabet, padded or not. Before,
  two spellings of one key counted as two grants, so revoking one left a
  client that presents the other admitted.
- The `observers` tools no longer write over a grants file they can't read.
  Before, when `observers.json` wasn't valid JSON or held a grant the host
  couldn't validate, `observers--grant` replaced the whole file with the
  one new grant, dropping every grant in it, protected operator-baseline
  grants included; `observers--get` listed no observers, and
  `observers--revoke` answered "no matching grant". Now a file the tools
  can't read as grants is left alone, and all three say what's wrong with
  it. In a file they can read, `grant` and `revoke` change only the entries
  they match and keep every other entry and field as found, and `get` lists
  the usable grants and names each one that isn't used. A grant or a revoke
  acts on every entry for its key, a revoke by label included, so no other
  entry for the key is left to be used in place of the one revoked.
  `observers--grant` refuses a key that doesn't decode to 32 bytes, and
  writes keys in one spelling. A missing file still means no grants yet. A
  link at that path stays a link: one whose file is gone is refused, and a
  write through a live link writes the file it points to, where the tools
  used to replace the link with a new file.
- A grant whose `expires` the web viewer can't read as a date is now a bad
  grant. Before, the viewer never expired it. **Operators:** a hand-edited
  grant with such an expiry now stops being used, and the file's other
  grants still are; the viewer's log names it. To repair it, give `expires`
  an ISO date, such as `2026-12-31T00:00:00Z`, or remove it. An expiry
  that's absent, `null`, `""`, `false` or `0` still means no end, as the
  viewer reads it.
- A file the viewer can't check no longer throws from its reload timer.
