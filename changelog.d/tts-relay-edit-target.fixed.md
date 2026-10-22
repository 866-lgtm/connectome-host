- When a voice client reports an interruption, the TTS relay edits only a
  message the agent's prose published, as agent-framework's
  `inference:published` reports it. It took its edit targets from
  `mcpl:speech-routed`, which also reports publishes that aren't the
  agent's prose, such as the `sleep` tool's announcement and a
  subconscious's `speak_in_channel`, so an interruption could edit one of
  those, or trim nothing when the newest of them was a post with no message
  id.
