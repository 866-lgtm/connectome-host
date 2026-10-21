- The fleet records a child as soon as its process is spawned, not only once
  it's ready, and writes that record to disk at once. A parent stopped or
  killed while a child starts then finds that child in its record at its next
  start, where before it knew nothing of it. A launch whose record can't be
  written stops its child and fails, saying why.
- A parent stopped or killed while it takes back its fleet's children at start
  leaves the fleet's record as it was, where before the record could hold only
  the children taken back so far.
