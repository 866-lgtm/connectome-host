- A recipe whose `agent.refusalHandling` is something other than an object,
  such as `true`, or whose `refusalHandling.autoRewind` isn't a boolean, is
  now refused when it loads, naming the key. Since agent-framework 0.22.3
  such a recipe loaded and then stopped the host at start-up with
  agent-framework's own error. Leaving it out, `false` and `null` still mean
  no refusal handling.
