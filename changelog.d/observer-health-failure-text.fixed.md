- A Web UI observer whose grant holds `health` but not `ops` no longer gets
  the text of failures, which the grant tool puts under `ops`: a failed
  call's error in the call ledger, an agent's last error, a provider
  cooldown's or wait's reason, compression debt's error, a health read's
  failure, and a quota read's error each come empty, in the live ledger, the
  welcome, `/healthz` and `/quota`, a fleet child's included. Its health
  keeps its numbers, flags and times, and the names, ids and codes it
  carries, so the page still shows that a call failed or a section couldn't
  be read.
