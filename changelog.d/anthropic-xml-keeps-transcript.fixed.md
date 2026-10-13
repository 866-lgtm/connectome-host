- A recipe with `agent.formatter: "anthropic-xml"` runs as a prefill transcript
  again. Since membrane 0.5.87 a formatter built without a tool mode leaves the
  mode to membrane, which picks native whenever the formatter supports it, and
  `AnthropicXmlFormatter` does. On 0.10.0 such an agent's requests became a
  native chat (alternating turns, native tool definitions, no assistant
  prefill, no speaker stop sequences), and so did its compression calls. The
  host now builds the formatter with `toolMode: 'xml'`, as the recipe's
  `anthropic-xml` promises, and the makeup panel's count does the same.
