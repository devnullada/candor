---
status: open
area: Candor trials
list: Change trials
effort: evening
paths:
  - trials/agent.ts
created: 2026-10-29
---

# Run supercronic's change requests on Kimi beside the other agents

Optional, parked (Pal, 2026-10-29): split from #1653f322. A fourth agent in the "Other agents" block; worth it as a check after the docs rounds change something.

- trials/agent.ts: a `kimi` agent (the Kimi Code CLI on PATH). Probe its headless output and permissions first in E:/tmp, as agy needed (allowlist, transcript format, tool names). Pal's quota is small.
- 8 runs (supercronic, 4 requests x Go/Candor), add it to the change repo's compare.json, `run.ts compare`, `bun run numbers`.
- Claude Code needs a permission rule for the runner with `--agent kimi` (Pal adds it; I can't edit my own settings).
