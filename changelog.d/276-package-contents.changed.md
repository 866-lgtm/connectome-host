- **Anyone who ran the tests, or rebuilt the web UI, from the installed
  package:** the npm package now carries `src`, `recipes`, `scripts`,
  `docs`, `tsconfig.json`, the built web UI and the root docs, and no
  longer the test suite, the web UI's sources, `bun.lock`,
  `CONTRIBUTING.md` or the repository's CI and changelog files. Run the
  tests, or rebuild the web UI, from a checkout. An install from a git URL
  packs the same files but has no web UI, since the built one isn't in
  git: install from npm or from a checkout for it. Running the host from
  the npm package, its web UI included, is unchanged.
