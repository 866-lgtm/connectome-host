- A headless host now exits once `headless.log` holds what was written to
  it, waiting at most 2 seconds, after which it says on its stderr that the
  log's last lines may be missing. A graceful shutdown used to exit 50 ms
  after ending the log, and a fatal error after the log opened exited at
  once, so on a busy host a failed stop's line, or the server's error when
  the socket's path was taken, could miss the file. A line written once the
  shutdown has ended the log, such as a client disconnecting, goes to the
  host's stderr; it used to make the log's stream fail, which could end the
  host before the log's last lines landed.
