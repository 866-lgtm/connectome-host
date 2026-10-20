- Agents can restart their own host (`modules.selfRestart`, off by default):
  the `lifecycle--restart` tool arms a restart that happens once the asking
  turn has ended and every agent is idle. The host exits with code 75 and
  its supervisor (launchd `KeepAlive`, systemd `Restart=`, a fleet parent's
  `autoRestart`) starts it again; after the restart the agent gets one
  context line saying when it asked, why, and when it came back. Only
  headless mode arms it, `cancel: true` disarms it, and `cooldownMinutes`
  (default 10) spaces restarts out. The request and the last completed
  restart live in `DATA_DIR` as `self-restart.json` and
  `self-restart.last.json`.
