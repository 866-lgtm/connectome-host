- `GET /debug/context?media=0` strips inlined base64 image payloads to size
  placeholders on the server again (also through `?scope=<child>`), so the Web
  UI's context document no longer pulls several MB per refresh over a tunnel.
  The context document renders stripped images as a labelled chip instead of
  a broken thumbnail.
