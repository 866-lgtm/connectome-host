- Batch mode no longer prints a credential an `/auth` line may carry when it
  echoes each stdin line: the words after the subcommand, or from a word
  `/auth` doesn't know, show as `<hidden>`, as in `> /auth token <hidden>`.
  Batch output goes wherever the host's stdout goes, a supervisor's journal
  or a CI log included.
