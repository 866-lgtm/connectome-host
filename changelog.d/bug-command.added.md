- `/bug <what happened>` assembles a bug report for connectome-host's public
  issues. It shows the report, saves it under `DATA_DIR`, and gives a link
  that opens GitHub's new-issue form with it filled in. Nothing is sent: the
  reporter reads it in the form and submits it under their own GitHub
  account, so it needs no credentials of the host's.
  - Besides the reporter's own words, the report holds only fields with a
    known shape: versions and commit, runtime and mode, the setup as
    structure (provider, a model id only when every word of it is a public
    model name, built-in modules, budgets, each MCP server by ordinal with
    its kind, transport and state), this process's provider failures as
    classifications, and this run's host errors as known class names and
    code locations in our own packages.
  - No log line, error message, request, response, prompt or recipe text is
    copied, into the report or the saved file, and no name a user chose
    (recipe, servers, custom modules, custom models, other packages), nor
    commands, arguments, URLs, env values or paths outside our own code.
    The error logs and provider errors can quote conversation text, so they
    are read only for these shapes.
  - Only a person runs it: the fleet's command tool refuses `/bug`.
  - A new issue form, `.github/ISSUE_TEMPLATE/bug_report.yml`, labels these
    reports `bug`.
  - `headless.log` now marks where each run begins, as `tui-error.log`
    already did, so a report reads only the current run's errors.
