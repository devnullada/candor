---
status: open
area: Tooling
list: VS Code extension
effort: weekend
blocked-by: [4486d0ca]
paths:
  - editors/vscode/src/server.ts
created: 2026-10-28
---

# Show each call's effects in the editor

Phase 6, the feature that is Candor's own; needs the position index.
- Inlay hints: at each call, the effects it performs (`· uses db, clock`), toggleable.
- Hover on a `uses` clause: for each effect, the calls in this body that need it (an unused effect is already CAN0014).
- Document symbols and outline: functions grouped or tagged by effect.

Done when `examples/` shows effect hints at every effectful call and the outline groups by effect.
