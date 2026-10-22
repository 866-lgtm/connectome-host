- **Operators:** connectome-host now requires `@animalabs/agent-framework`
  ^0.24.1 (was ^0.24.0). Besides clock rows (`agent.clock`), the changes
  operators meet, in brief; agent-framework 0.24.1's notes give each in full:
  - **The workspace's `edit` and `edit_many` refuse** a file the workspace
    holds when the check of disk before them decided nothing, because the
    selected branch kept changing while it ran, and say to make the same
    call again. For a path the workspace doesn't hold, where that check
    decided nothing, `delete`, `edit`, `edit_many` and `readBinary` now say
    disk couldn't be checked, where they answered "File not found".
  - **A turn's tool results share the readers' per-message bound** when they
    pass it together, each taking an equal share, where a later result was
    cut or left out without a word. A cut result's notice, which names the
    workspace file holding the rest, now survives the readers' cut unless a
    turn's notices alone fill the bound, or a mount name past about seventy
    characters makes the notice longer than its room.
  - **A message that arrives during a tool call** is injected as the agent's
    strategy renders it as the newest of its window, where it was injected
    whole, so one over `maxMessageTokens` or with more images than
    `maxLiveImages` no longer makes the next request differ from what the
    live stream carried. A strategy without that render still gets the
    message as stored, and nothing is injected mid-turn on the
    `anthropic-xml` formatter. A message the next compile won't send among
    its newest isn't injected: a stored `[not shown]` line tells the agent
    who sent it, its size, and the `history--extract` call that reads it, or
    its id where the agent isn't shown that tool.
  - **`channel_close` refuses a tuned-out channel,** as `channel_open` and
    `channel_decline` do, and says to cancel the tune-out first, which
    delivers what it diverted. A tune-out on record where there's no
    tune-out coordinator now ends as the channels come up, and its channel
    is decided open again; what it diverted isn't delivered, and a log line
    counts it.
  - **A modern MCP server's `requestTimeoutMs` that can't be printed** is
    refused like any other wrong deadline. Checking it used to throw, which
    failed that server's connection and made `listMcplServers` throw rather
    than list any server.
