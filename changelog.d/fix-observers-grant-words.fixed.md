- `observers--grant` refuses an `expires` that isn't text, such as a
  number, where it dropped it and saved a grant with no end. It also
  refuses one that has already passed, where it saved a grant the web
  viewer never admits and answered that it would be live within about 3 s;
  given for a key that held a grant, that call ended the grant. And it
  takes an `expires` only as a date in the ISO form, `YYYY-MM-DD` or
  `YYYY-MM-DDTHH:MM:SSZ`, where an offset such as `+02:00` can stand for
  `Z`, and stores it as ECMAScript's own form writes it, with `T` before
  the time and an offset's colon, or a time without a zone as the instant
  this host reads it as, in UTC, so the web viewer reads it as the grant
  checked it. Text in another form was read by a lenient parser, so
  `"3600"` and `"3600."` saved a grant until the year 3600, and
  `"05/06/2026"` one until May 6. What it took before and refuses now: a
  date written another way, such as `"Oct 18 2026"`, `"10/18/2026"` or
  `"2027.01.01"`; a year alone, such as `"2027"`; and a day the month
  doesn't have, such as `"2026-02-30"`, which was read as March 2. A date
  alone means its start, 00:00 UTC. A time without a zone is still taken,
  and read in the host's time zone, as before, then stored as that
  instant, so `Z` or an offset makes it exact. The answer to a grant with
  a date alone or a time without a zone names the instant this host reads
  it as. The grants file is read as before, so an operator's `"2027"`
  written there still reads as the start of 2027. The refusal for a passed
  expiry says that `observers--revoke` ends the key's grants, if it has
  any and none is protected. Absent, `null` or empty still means no end.
- Grants saved before this fix with a dropped `expires` hold `"expires":
  null` in the grants file, the same as a grant meant to have no end, so
  the file can't tell them apart. Whoever runs a host can check each grant
  in the file whose `expires` is `null` or absent, and revoke any that was
  meant to end. In the agent's history, an `observers--grant` call whose
  `expires` wasn't text marks such a grant.
- `observers--grant` and `observers--revoke` name every wrong input at
  once, each with what to give. A revoke given a key or label that isn't
  text, and nothing usable beside it, names the value. A revoke that
  matches nothing names the key or label it was given, and one by a label
  two grants share is refused with each of their keys. A protected grant's
  refusal says it's part of the host's baseline, which only whoever runs
  the host can change or remove, where it told the agent to edit a file it
  can't reach. A write of the grants file that fails says nothing changed
  and the file is as it was, and, when the host has too many files open,
  that it can pass and to grant or revoke again shortly. A read of the
  grants file that fails that way gets the same answer from grant, revoke
  and get, where they asked whoever runs the host to repair a file nothing
  is wrong with. A tool the observers module doesn't have is answered with
  the ones it has, and so is a name the idle-limit module doesn't have,
  with its pointer to `agent_settings`.
- In `agent_settings`, `channel_idle_limits` names every bad entry at
  once, an empty channel id among them, and says the field wasn't changed
  and none of its entries were applied. It says that other settings given
  in the same call may not all have been applied, and that
  `agent_settings` with action `"get"` shows each as it stands.
