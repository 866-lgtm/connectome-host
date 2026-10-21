- Agents can restart their own host (`modules.selfRestart`, off by default):
  the `lifecycle--restart` tool arms a restart that happens once the asking
  turn has ended and nothing is in flight (every agent idle, no turn,
  subagent run or background script alive). The host exits with code 75 and
  its supervisor (launchd `KeepAlive`, systemd `Restart=`, a fleet parent's
  `autoRestart`, which the child's entry must set) starts it again; a fleet
  parent's own self-restart stops its children, and the restarted parent
  starts again only its `autoStart` ones. After the restart one context line
  says which agent
  asked, when, why, and when the host came back. Only
  headless mode arms it, `cancel: true` disarms it, and `cooldownMinutes`
  (default 10) spaces restarts out. The request and the last completed
  restart live in `DATA_DIR` as `self-restart.json` and
  `self-restart.last.json`.
