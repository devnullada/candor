# Job queue

An HTTP service that runs jobs on a fixed pool of workers, with retries, timeouts,
cancellation and a graceful shutdown. A job's work is simulated: it waits.

## Running

- The program reads the port from `PORT` and serves HTTP on `127.0.0.1:$PORT` (not every
  interface). `WORKERS` is the pool's size, 4 if unset.
- Nothing is stored: a fresh start has no jobs. Ids are integers given out from 1, in order.
- Every response body is JSON; an error's body is `{"error": "<message>"}`, with any message
  that helps.

## A job

`POST /jobs` with `{"duration": 200, "fails": 1, "retries": 2, "timeout": 500}`:

- `duration` (required): how long one attempt takes, in milliseconds, 0 or more.
- `fails` (default 0): how many attempts fail before one succeeds.
- `retries` (default 0): how many times a failed attempt is tried again.
- `timeout` (optional, more than 0): an attempt still running after this many milliseconds is
  stopped and fails.

Attempt number `k` (from 1) waits `duration` milliseconds and then succeeds, except:

- if `timeout` is set and `duration` is more than it, the attempt is stopped after `timeout`
  milliseconds and fails with the error `"timeout"`;
- otherwise, if `k <= fails`, it fails at its end with the error `"failed"`.

After a failed attempt with retries left, the job waits `100 * 2^(k-1)` milliseconds (100,
200, 400, ...) and then queues again. A job waiting out its backoff doesn't hold a worker. With
no retries left, it has failed.

The answer to `POST /jobs` is 201 and the job. A missing or negative `duration`, a negative
`fails` or `retries`, a `timeout` of 0 or less, a field of the wrong type, or a body that isn't
JSON: 400.

A job, as `GET /jobs/{id}` answers it (200):

```
{"id": 1, "state": "running", "attempts": 1, "error": null}
```

- `state`: `queued` (waiting for a worker), `running`, `retrying` (waiting out a backoff),
  `done`, `failed`, or `cancelled`.
- `attempts`: how many attempts have started.
- `error`: the last failed attempt's error, or null.

Workers take queued jobs oldest first. No more than `WORKERS` attempts run at once, and while a
job is queued no worker sits idle.

## Endpoints

| Request              | Answer                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| `POST /jobs`         | 201 and the job (above)                                                |
| `GET /jobs/{id}`     | 200 and the job                                                        |
| `DELETE /jobs/{id}`  | cancels it: 200 and the job, now `cancelled`; 409 if it is already `done`, `failed` or `cancelled` |
| `GET /stats`         | 200, `{"workers": 4, "running": 0, "maxRunning": 3}`                   |
| `POST /shutdown`     | 202, `{}`, and the shutdown below                                      |

- Cancelling a running job stops its attempt within 50 milliseconds and frees its worker. A
  cancelled job never runs again.
- `running` is how many attempts run now; `maxRunning` is the most that ran at once since the
  program started.
- Shutdown: from then on `POST /jobs` answers 503. Queued and retrying jobs are cancelled.
  Running attempts finish (one that fails is not retried: its job has failed). Once none is
  running, the program exits with status 0. Until then, every other request is answered.
- An id in a path that names nothing (including one that isn't an integer): 404. A path that
  matches no endpoint: 404. A known path with the wrong method: 405.

## Tests

Write tests in the language's own way for each rule above. They are yours; separate tests,
which you don't see, start the program and send it requests.
