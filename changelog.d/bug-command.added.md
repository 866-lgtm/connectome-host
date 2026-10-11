- `/bug <what happened>` assembles a bug report for connectome-host's public
  issues. It shows the report, saves it under `DATA_DIR`, and gives a link
  that opens GitHub's new-issue form with it filled in. Nothing is sent: the
  reporter reads it in the form and submits it themselves, so no GitHub
  login or token is needed.
  - Besides the reporter's own words, the report holds only fields with a
    known shape: versions and commit, runtime and mode, the setup as
    structure (provider, a model id only when it is the provider's public
    id, built-in modules, budgets, each MCP server by ordinal with its kind,
    transport and state), provider failures as classifications, and host
    errors as known class names and code locations in our own packages.
  - No log line, error message, request, response, prompt, recipe text,
    server name, command, argument, URL, env value or path is copied, into
    the report or the saved file. The error logs and provider errors can
    quote conversation text, so they are read only for these shapes.
  - A new issue form, `.github/ISSUE_TEMPLATE/bug_report.yml`, labels these
    reports `bug`.
  - `headless.log` now marks where each run begins, as `tui-error.log`
    already did, so a report reads only the current run's errors.
