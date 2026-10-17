- Revoking an observer's grant, its expiry, or removing the grants file
  now ends the sessions and open connections the grant gave: within about
  3 s of a revoke or an expiry, and within about 6 s of the file's
  removal. `observers--revoke` says so. Before, it ended only new ones: a
  session cookie minted at the observer's hello kept the grant's HTTP
  routes for up to 12 hours, and an open WebSocket kept its scopes until
  it closed. A session ends at the check that finds its grant gone,
  whether or not it's used meanwhile. A connection whose grant is gone or
  expired is closed as final, so the web viewer shows the observer as
  denied rather than reconnecting. A grant narrowed in place narrows its
  sessions for good, ending one it leaves with none of its scopes, and
  closes its connections, which connect again with the new scopes. A grant
  given again, or widened, after a check has seen it gone or narrowed
  takes a new hello. An entry the viewer can't use counts as no grant. A
  read of the grants file that fails, as a passing EIO or EMFILE can, now
  counts as a check that didn't find the file, so it takes the grants away
  only if the next check fails too. When it does, the viewer can't tell
  who is granted, so it ends every observer's sessions and connections,
  and viewers stay off until someone reloads them, even once the file
  reads again. A grants file that parses but holds no grant the viewer can
  use, such as one whose `observers` isn't a list, ends every observer's
  sessions and connections at the check that reads it.
