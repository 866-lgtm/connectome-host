- Requires `@animalabs/agent-framework` ^0.22.3. What changes in the host with it:
  - After an interruption, the TTS relay's note to the agent says the posted
    message "could not be trimmed" when the server refuses the edit, where it
    said the message was trimmed to match: 0.22.3 gives a module's `callTool`
    an MCPL server's error result as a failure.
  - The Web UI's agent tree, and a fleet child's agents in the TUI's tree,
    show a turn the framework gave up on (`inference:exhausted`) as failed,
    where they showed it as cancelled: from 0.22.3 a stop or a shutdown ends a
    turn with `inference:aborted` alone, and `inference:exhausted` means the
    turn failed.
  - An agent overlay entry's `reconnect` written as the text `"false"`, in
    any case and with any spaces around it, is read as false, where its truth
    turned retrying on. Any other value that isn't `true` or `false` is still
    read by its truth, and the startup warnings name each. 0.22.3 refuses any
    value but `true`, `false` or `null`, so the overlay hands it `true` or
    `false`.
