- `--audit-stores [--recipe <recipe>] <data directory>…`, given to the host's
  entry in place of a recipe (`bun src/index.ts --audit-stores …` in a clone),
  says whether this version opens the agent's context in every store, before
  you start the agents on it. For a data directory, such as an agent's
  `DATA_DIR`, it opens it in every session's store the way a start of this
  version does, but one that reaches past what an update copies, such as a
  store outside the directory or one holding a link out of it, which it says
  it didn't open, and one a session names that isn't there yet, which a start
  makes empty, under the recipe a start would load: the one `--recipe`
  names, or else the one the last start saved. It audits each fleet child the
  recipe names too, in a process of its own, as the fleet launches it, given
  5 minutes to end, or the minutes `CONNECTOME_FLEET_CHILD_AUDIT_MINUTES` in the
  audit's environment gives: a number above 0, a larger one than a timer
  holds (about 35,791 minutes) giving the longest it does; 0 or below, or not
  a number, gives 5. It
  opens the stores in place, so run it after taking the copy you'd go back
  to: "Updating an install" in docs/DEPLOYMENTS.md says when. It prints a line
  on stderr for each store under each agent name it opens it under, the
  recipe's or the default and each session's own, or one for a store it
  doesn't open, and exits 0 when no store was refused and every
  one there was audited, 1 otherwise. Run it with the agents and their
  children stopped.
