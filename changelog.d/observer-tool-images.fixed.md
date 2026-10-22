- A Web UI observer whose grant doesn't hold `tools` no longer gets the
  images a tool returned, as it already didn't get the tool's result: its
  conversation leaves them out, and `/media` refuses them. An image in a
  message itself still reaches every observer that holds `messages`.
