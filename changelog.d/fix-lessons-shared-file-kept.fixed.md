- A host no longer writes over a shared lessons file it can't read as a
  lessons file: one that doesn't parse, isn't UTF-8 text, can't be read,
  or isn't an object holding a `lessons` list. It keeps its lessons in its
  own state, names the problem once in its log, says so when the file
  reads as a lessons file again, and writes it again from then on, merging
  in what it holds. Before, such a file was taken for absent, and the next
  save replaced it with the host's own lessons, except one that isn't
  UTF-8 text but still parsed, which was read with its bad bytes replaced
  by U+FFFD and written back that way. A file that starts with a
  byte-order mark now reads, and is written back without it.
- Each call that changes a lesson reads the shared lessons file and merges
  it in first, so the change is made to the newest copy, and stamps the
  change past that copy, so it outranks it whatever the hosts' clocks say:
  a lesson another host added since this one started, or a change another
  host made to the same lesson, is kept rather than written over. Of two
  copies of a lesson, the file's replaces the host's unless the host's is
  newer, so a hand edit that left `updated` as it was is kept. An
  `updated` past `Number.MAX_SAFE_INTEGER`, which no clock gives, counts
  as none.
- A write replaces the shared file whole, through a temporary file beside
  it, synced to disk, given the file's permissions and renamed over it, so
  a write that fails leaves the file as it was, a machine that goes down
  leaves it whole, with the old text or the new, and a link to the file
  stays a link. A file that isn't there yet is made the same way, so a
  first write that fails leaves no file. The file is a new one, owned as
  any new file the writing host makes there, and an access control list or
  other extended attribute set on it isn't kept. It's written in place, as
  before, through a link to a file not made yet, for a file the host can't
  write, which is refused as before, for a file with a second name (a hard
  link), and where, for a file that's there, its directory can't be
  written in or the file is mounted on its own, also in a directory on a
  read-only mount; for the last two, the log says so once, before the
  write. A write keeps the file's other keys and each entry where it
  stood. A failed write is named once in the log and tried again at the
  next change, unless it left the file broken, which the log then says,
  and a write that makes the file because it wasn't there says so. A host
  that stops between making its temporary file and the rename leaves that
  file, `lessons-<random>.tmp`, beside the shared one.
- Hosts stop loading entries without a named id, and keep them in the
  file. A named id is text, not empty, that the file holds once at most
  and the host once at most. An entry without one, or one that isn't an
  object, is written back as `JSON.parse` reads it, and a log line counts
  them at start, and again at a change's read when they've changed. A
  lesson of the host's own whose id another lesson also holds isn't
  written, and the log names it once. Before, the start's merge could
  overwrite or drop a lesson without a usable or unique id. While the file
  holds an id of the host's lessons twice, a change to that lesson is
  refused, since the host can't tell which entry its copy came from. The
  refusal, and the log line for that lesson, say which entry to give a new
  id: the one with the earlier `updated`, or either on a tie, and of three
  or more, all but one with the latest. Done that way, every host keeps
  every lesson unless it holds a change to the lesson that the file lacks.
  A host that read the file while it held the id twice also takes the
  file's copy once the two are resolved, however that was done. A new
  lesson's id is one the host doesn't hold, nor the file when the call
  could read it.
- Every host that shares the file needs this change to keep what the
  others write: a host on an earlier version still writes its own lessons
  over the whole file. Two hosts that write at nearly the same moment can
  still lose one's change, between one host's read and the other's write,
  until the host that lost it next changes a lesson, unless the other
  changed the same lesson with the same or a later stamp. A lesson removed
  from the file by hand comes back while a host holds it: deprecate a
  lesson to retire it. Where the file is written in place, a crash or a
  failed write in the middle of it, or two hosts writing it at nearly the
  same moment, can leave the file broken: every host then names it and
  leaves it alone. Repair it by hand, or move it aside, keeping any lesson
  only it holds, for the hosts to write it again from their own lessons.
