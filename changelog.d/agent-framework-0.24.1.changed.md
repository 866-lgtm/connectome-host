- **Operators:** connectome-host now requires `@animalabs/agent-framework`
  ^0.24.1 (was ^0.24.0). Besides clock rows (`agent.clock`), the changes
  operators meet, in brief; agent-framework 0.24.1's notes give each in full:
  - **The workspace's `edit` and `edit_many` refuse** a file the workspace
    holds when the check of disk before them decided nothing, because the
    selected branch kept changing while it ran, and say to make the same
    call again. Where that check decided nothing, `delete`, `edit`,
    `edit_many` and `readBinary` now say disk couldn't be checked, where
    they answered "File not found".
  - **A turn's tool results share the readers' per-message bound** when they
    pass it together, each taking an equal share, where a later result was
    cut or left out without a word. A cut result's notice, which names the
    workspace file holding the rest, now survives each reader's per-message
    cut until a turn's notices alone fill the bound.
  - **A message that arrives during a tool call** is injected as the next
    compile would send it, so the next request's prompt cache holds. One the
    next compile won't send isn't injected: a stored `[not shown]` line
    tells the agent who sent it, its size, and how to read it.
  - **`channel_close` refuses a tuned-out channel,** as `channel_open` and
    `channel_decline` do, and says to cancel the tune-out first, which
    delivers what it diverted. A tune-out on record where there's no
    tune-out coordinator now ends as the channels come up.
  - **A modern MCP server's `requestTimeoutMs` that can't be printed** is
    refused like any other wrong deadline, where checking it threw.
