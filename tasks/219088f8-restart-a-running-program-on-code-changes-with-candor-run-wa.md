---
status: open
area: Tooling
list: CLI
effort: evening
paths:
  - src/cli.ts
  - docs/design.md
  - docs/start.md
created: 2026-11-03
---

# Restart a running program on code changes with `candor run --watch`

Pal asked on 2026-11-03 whether the backend hot reloads. It doesn't: `candor run` compiles, builds with Go and starts the program once, and src/cli.ts has no watch mode. `fs.watch` lets a Candor program watch files at runtime, but doesn't reload its code.

Decided: restart on change, not code swapped in a running process. Go has no real support for that, and it would add a large runtime mechanism for little gain.

Who it's for: a person trying out a service. An agent's loop is `check` and `test`, so this won't move the trial figures.

Scope:
- `candor run --watch file.candor`: watch the entry file and everything it imports, debounced. The import graph should come from the compile, so a new import is watched without a restart.
- On a change, compile first. If that fails, print the diagnostics and leave the old process running.
- If it compiles, stop the old process, then build and start the new one. Check on Windows: a running exe may be locked against the rebuild, so the stop order or the build's output path may need to allow for that.
- Stop the child when the watcher stops, so no server is left holding its port.
- Say in the docs that a restart loses in-memory state; SQLite files and anything else on disk survive.
- Log the decision in design.md, with its tests.

Not checked: how long a rebuild takes on a real service, which decides how usable this feels.

Done when: tests show that a save restarts the program, a broken save leaves the old one running and prints its errors, and stopping the watcher leaves no child process, on Windows included.
