- A fleet child's exit now sends SIGKILL to what is left of the process group
  it led, so a process it started there, such as a server that doesn't exit
  when its stdin closes, doesn't go on running after it. The parent does this
  when it sees the child exit, when it stops a child it took back at its start
  while its connection to that child is open, and as the parent itself exits,
  for each child it started and each it took back whose connection is open,
  unless it is detaching and leaves its children running. A signal the system
  refuses is logged, except as the parent exits, and a stop says what of the
  group is left.
- On a host started from an install, a fleet child begins only once the
  fleet's children file lists it, so the file names each child before it can
  write in its data directory. A child whose parent ends before telling it to
  begin exits having done nothing. A child that ended while no parent ran
  stays listed while a process of its group remains, and so does another
  writer's entry, such as a store audit's. `fleet--kill` of such a child
  signals nothing of its group, and its result says that a process of the
  group still runs, as it does wherever a process of a child's group is left,
  and whether the parent's signal to the group went out.
