- A host notice that can't be posted because its channel isn't registered,
  or its server is gone, connecting or down, or because the connection
  refused it before writing anything, is kept and posted if the server
  reconnects, as the notices module means to do while a chat server is
  simply not up. It reads agent-framework's refusal `reason` for this,
  since 0.24's refusals no longer say `not found`, which it matched before.
  A notice refused while its server was down and being reconnected is now
  kept, where it was dropped. A first post refused for any other reason is
  logged and not kept, as before.
