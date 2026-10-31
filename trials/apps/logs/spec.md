# Log analyser

A command-line program that reads an HTTP access log on standard input and prints a report on
standard output. No network, no files.

## Input

One request per line, five fields separated by single spaces:

```
2026-10-25T10:00:01Z GET /items/3 200 12ms
```

- A timestamp `YYYY-MM-DDTHH:MM:SSZ` (digits where the letters are; always UTC, always `Z`).
- A method: `GET`, `POST`, `PUT`, `PATCH` or `DELETE`.
- A path, starting with `/`.
- A status, a number from 100 to 599.
- A latency: digits, then `ms`.

Lines may end in `\n` or `\r\n`, and the last may have no line ending. A blank line (nothing,
or only spaces) is skipped. Any other line that doesn't match is **malformed**: it is counted,
and a warning goes to standard error, `warning: line 4: malformed`, numbering every line of the
input from 1 (blank ones included).

## Arguments

```
app [--status CLASS] [--since TIMESTAMP] [--by path|status|method|minute] [--top N]
```

- `--status`: only requests with this status: a class (`1xx` to `5xx`) or an exact status
  from 100 to 599 (`404`).
- `--since`: only requests at or after this timestamp (same form as in the log).
- `--by`: what the requests are grouped by in the report (default `path`).
- `--top`: how many groups the report lists, 1 or more (default 10).

Flags come in any order, each at most once, each followed by its value. An unknown flag, a
flag without a value, a flag given twice, anything else on the command line, or a value not
of the form above (`--top 0`,
`--status 6xx`, `--by host`, `--since yesterday`) is a usage error: a message starting
`error: ` on standard error, nothing on standard output, and a non-zero exit status, without
reading the input.

## The report

Requests are the well-formed lines that pass the filters. Malformed lines are counted whatever
the filters.

```
requests: 6
malformed: 1
status: 2xx 4, 4xx 1, 5xx 1
errors: 16.7%
latency: p50 12ms, p95 250ms, max 250ms
top paths:
  4  avg 15ms  /items/{id}
  2  avg 130ms  /orders
```

- `status`: the count in each class, `1xx` to `5xx` in that order, leaving out classes with
  none.
- `errors`: the share of requests with a 5xx status, as a percentage rounded half up to one
  decimal (`16.7%`, `0.0%`, `100.0%`).
- `latency`: percentiles by nearest rank: with the `n` latencies sorted, `pK` is the one at
  position `ceil(K * n / 100)` (from 1). `max` is the largest.
- `top <by>s:` (`top paths:`, `top statuses:`, `top methods:`, `top minutes:`) then one line per
  group: two spaces, the count, two spaces, `avg` and the mean latency rounded half up to a whole
  millisecond, two spaces, the key. Most requests first; equal counts by key, ascending (plain
  character order). At most `--top` groups.
- The keys: for `path`, the path with every part (between `/`s) that is one or more digits and
  nothing else replaced by `{id}`
  (`/items/3/notes/17` is `/items/{id}/notes/{id}`); for `status`, the status (`404`); for
  `method`, the method; for `minute`, the timestamp without its seconds (`2026-10-25T10:00`).

With no requests, the report is only the first two lines (`requests: 0` and `malformed: N`).

Each line ends with `\n`. The exit status is 0 whenever the arguments are valid, malformed
lines or not.

## Tests

Write tests in the language's own way for each rule above. They are yours; separate tests,
which you don't see, run the program with arguments and input and read what it prints.
