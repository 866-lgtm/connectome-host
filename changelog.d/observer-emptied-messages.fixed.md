- A Web UI observer is no longer sent a message whose every part its grant
  leaves out, such as a tool's call and result without `tools` or a turn of
  thinking alone without `thinking`, which reached it as an empty row with
  its time. A page of older history that such messages would leave empty
  reads further back, up to ten pages' worth. Past that the page comes back
  empty: a bulk load stops there, and the "older messages" row reads on
  with a click. An observer that connects while such messages fill the
  welcome's tail opens on the last messages it may see within ten pages'
  worth before it, read back the same way.
