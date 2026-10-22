- The host no longer prints its own warning, beside agent-framework's, for a
  credential that would go over `ws://` to another machine. agent-framework
  warns when it connects such a server, for `http://` as well as `ws://`,
  and for more places a credential can sit in a url. It counts `localhost.`
  and names under `.localhost` as this machine, so a credential sent to one
  of those now gets no warning.
- An agent overlay entry with `"transport": null` reads as naming no
  transport, as it did under agent-framework 0.22, where 0.23 refused it
  whatever else it said. Such an entry with a url, or with a command, starts
  its server again, and a credential it carries over `ws://` is sent, with
  agent-framework's warning. One with both a command and a url is refused, as
  under 0.23 it is with no transport at all.
- The host's startup line for an agent overlay entry that agent-framework
  refuses no longer says the framework ignores a transport it doesn't know,
  and now also names entries the framework refuses for other settings, such
  as an `https://` url carrying a user and password. agent-framework's own
  startup line says why it refuses the entry.
- The overlay tools' receipts and the startup lines for an agent overlay
  entry no longer say that an entry agent-framework refuses lacks the
  operator's env, token or grants, since nothing connects in its place. An
  entry with a command beside an `https://` url under `transport: "http"`
  is read as dialling the url, as agent-framework does, so what they say of
  it concerns its url, token and access grant, not the command's env.
