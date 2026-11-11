---
status: open
area: Candor trials
list: Change trials
effort: bigger
created: 2026-10-31
---

# Add a 15k-line codebase to the change trial, with cross-module requests

The size where effect signatures should pay, and where Candor's weak spots at scale will show.

Today's codebases are 1.5k-9k lines and the requests touch one or two files: small enough that Go is read whole. Candor's design (effects in signatures, an outline instead of bodies) should show on a bigger one, and what breaks there is what to fix.

Choices:
- One Go app of 15k+ lines, backend, HTTP + SQL + background work, permissive licence. Candidates to weigh: miniflux, gotify, a forge or wiki. Pick it with Pal.
- Ported to Candor the way the others were.
- 6 requests: 2 features, 2 changes, 1 bug, 1 refactor. At least 3 must cross three or more modules, and at least 2 must hinge on side effects (what touches the db, the network, the clock).

Done when: the port passes the shared tests, the 6 requests have hidden tests and references on every side, and the brief names the app.
