- Makeup panel: on provider `anthropic`, the exact `count_tokens` figure
  counts earlier turns' server-tool blocks (web search and the like), which
  membrane 0.6.0 sends back with every later request. 0.12.0's figure left
  them out, so it ran low from a server-tool turn on.
