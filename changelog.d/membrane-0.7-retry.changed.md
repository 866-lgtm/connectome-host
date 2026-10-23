- **Operators:** connectome-host now builds its `Membrane` on
  `@animalabs/membrane` ^0.7.1, where membrane is the one retry layer under
  the framework: the Anthropic SDK client's own retries are off, membrane's
  schedules run on `streamYielding()` (agent-framework's turn path) too, and a
  connect timeout reaches the framework after one attempt, as a retryable
  `timeout`, where the SDK made three. The host's default retry config
  (`hostMembraneRetry`) turns membrane's overloaded schedule (seven attempts
  over about ten minutes at a 529) off, so a 529 gets the base schedule's three
  sends, 1 s then 2 s apart, as the SDK client sent inside each of
  agent-framework's attempts before; agent-framework's own policy retries
  above it as it did. Internal calls on the other paths (compression,
  retrieval) lose the ten-minute overloaded patience they had and keep their
  own layers' backoff. A recipe's `agent.retry` is laid over that default, so
  `agent.retry.overloaded` brings a patient 529 schedule back.
  **Unchanged:** a call whose first attempt succeeds, and what a failed call's
  error says.
