- **Operators and developers:** install and run connectome-host on Node
  22.12 or later and Bun 1.4.3 or later. `package.json` now declares both
  (`engines.node: ">=22.12.0"`, `engines.bun: ">=1.4.3"`). npm warns at an
  install on an older Node; npm 11 and Bun 1.4.3 don't check the Bun floor
  at install.
  - **Node** runs the install, whose postinstall builds the Web UI with npm
    and Vite, and the release-hold checks. Node 20 reached its end of life
    on April 30, 2026, and Node 22 is the oldest line Node still supports.
    22.12.0 is the floor the stack's packages share, and every locked
    package that states an `engines.node` admits it.
  - **Bun** runs the host. None of Bun's releases went to an older minor
    after a newer one shipped, so the floor is its newest release when it
    was set, 1.4.3, and nothing older is tested in CI or supported.
  - **CI** runs the install, the Web UI build and the tests on Linux at Node
    22.12.0 with Bun 1.4.3, at Node 24 with the newest Bun, and at the newest
    Node with the newest Bun, and the install and build on macOS at the two
    ends. Its build-and-test check names now carry the Node and Bun each
    job asks for.
