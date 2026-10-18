- A lesson stored without usable content, tags or evidence, as earlier
  versions could store one and a hand edit of the shared lessons file can,
  no longer makes `lessons--query`, `lessons--list` or `/export` fail.
  Every reader, retrieval included, reads a missing field as empty, reads
  a list whose entries aren't all text by the entries that are, and reads
  evidence stored as one value as a list of that one. The stored record is
  left as it is until the lesson is updated, and an update that adds
  evidence keeps every value already stored. `lessons--list` and
  `lessons--query` mark each lesson stored without usable content or tags
  with what's wrong and how to fix it, the host's log names each one in
  one line when lessons load, and retrieval no longer injects a lesson
  with no content. An entry in the shared lessons file that isn't an
  object, or a shared file that holds just `null`, no longer stops lessons
  from loading.
- A lesson stored with a confidence outside 0 to 1, such as 85 meant as
  85%, or with one that isn't a number, is ranked and filtered as the
  nearer end of that range: 85 ranks as 1, the top of the range, beside
  any lesson stored at 1, and one that isn't a number as 0. Text that
  holds a number, such as "0.9", reads as that number. A number in the
  shared file too large for JSON to hold, such as `1e999`, reads as one
  that isn't a number, where it stopped lessons from loading.
  `lessons--list` and `lessons--query` show the confidence as stored and
  say how to fix it, the host's log names it when lessons load, and
  `lessons--boost` and `lessons--demote` leave such a lesson as it is,
  saying to give it a confidence from 0 to 1 first. The TUI's `/lessons`,
  the web viewer's lessons list, headless mode, retrieval and `/export`'s
  markdown show the confidence a lesson is ranked by, the markdown with
  each lesson's mark, and `/export`'s JSON holds the lessons as stored.
- `lessons--update`, `lessons--deprecate`, `lessons--boost` and
  `lessons--demote` refuse an id that's missing, empty or not text, saying
  so, before looking a lesson up. A call with no id used to edit the first
  lesson stored without one, and one with a number reached a lesson stored
  with that number though each tool's id is text. A lesson stored without
  an id, with an empty one or with one that isn't text is marked and
  logged as one no call can name.
