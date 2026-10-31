# Rate limiter

An HTTP service that decides whether a caller may go ahead, by a limit per key over a
sliding time window. Other services ask it before doing work.

## Running

- The program reads the port from `PORT` and serves HTTP on `127.0.0.1:$PORT` (not every
  interface).
- `LIMIT` (default 10) and `WINDOW` (milliseconds, default 1000) are the limit and window of
  every key that has none of its own.
- Nothing is stored: a fresh start has no history.
- Every response body is JSON; an error's body is `{"error": "<message>"}`, with any message
  that helps.

## Checks

`POST /check` with `{"key": "alice", "cost": 2}`:

- `key` (required): a non-empty string.
- `cost` (default 1): an integer, 1 or more.

A key's **used** amount at a moment is the sum of the costs of its allowed checks made less
than its window ago (a check made exactly a window ago no longer counts). The check is allowed
if used + cost is at most the key's limit.

- Allowed: 200, `{"allowed": true, "remaining": R}` where `R` is limit − used − cost. The check
  is recorded.
- Denied: 429, `{"allowed": false, "remaining": R, "retryAfter": T}` where `R` is limit − used,
  and `T` is how many milliseconds from now until the same check would be allowed (the
  soonest moment enough recorded costs have aged out), at least 1. A denied check is not
  recorded.
- A cost larger than the key's limit could never be allowed: 400.
- A missing or empty `key`, a `cost` less than 1, a field of the wrong type, or a body that
  isn't JSON: 400.

Checks on the same key may arrive at the same moment, from many callers: a key's limit holds
under concurrent checks (with a limit of 20, of 50 checks sent at once exactly 20 are
allowed). Keys are independent of each other.

## Limits

| Request             | Answer                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `PUT /limits/{key}` | body `{"limit": 5, "window": 500}`, both integers, 1 or more: sets the key's own limit and window; 200 and `{"key": "alice", "limit": 5, "window": 500}`. A missing or bad field, or a body that isn't JSON: 400 |
| `GET /limits/{key}` | 200 and the key's limit and window, in the same form (the defaults if it has none of its own) |
| `GET /stats`        | 200, `{"keys": 2, "allowed": 7, "denied": 3}`                           |

- Changing a key's limit or window keeps its recorded checks: the new values apply from the
  next check on.
- `keys` is how many different keys have been checked (allowed or denied); `allowed` and
  `denied` count checks since the program started. A check answered 400 counts in none.
- A path that matches no endpoint: 404. A known path with the wrong method: 405.

## Tests

Write tests in the language's own way for each rule above. They are yours; separate tests,
which you don't see, start the program and send it requests.
