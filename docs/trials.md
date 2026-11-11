# Trials

Candor is for AI coders, so it is measured by what an AI coder gets done in it, next to Go. Two
trials:

- **Changing a codebase**: an agent reads an app it has never seen and adds a feature, fixes a
  bug or refactors it. Most work on a backend is this, and it is where Candor should pay off.
- **Writing from a spec**: an agent writes a small app from scratch.

Both are run headless with no questions asked, and scored by hidden tests that talk to the
program from outside, so the same tests score every language. Harness and apps:
[trials/README.md](../trials/README.md).

Figures in the marked blocks come from [trial-numbers/numbers.json](../trial-numbers/numbers.json)
and are rewritten by `bun run numbers`; the text around them is written by hand. A dash is a
figure not measured yet.

## Changing a codebase

Each app exists twice, as its Go original (trimmed to what the port covers) and as its Candor
port, and both pass the same shared tests. The agent gets one of them in a git repository and a
request. Its change is then scored by the request's hidden tests, by the shared tests (anything
it broke), and for a refactor by a check that the old shape is gone.

The Go sides were written by people and the Candor sides by a model. The model knows Go well and
learns Candor from its docs, in the run.

The codebases, requests and hidden tests are not in this repo: the Go is other people's code,
and published tests would end up in the next models' training data. The runner uses this repo's
[harness](../trials/harness.ts) and [agent](../trials/agent.ts).

<!-- numbers:change generated from trial-numbers/numbers.json by `bun run numbers` -->
Claude Code, `sonnet`, Candor 0.0.30, 2026-10-31. Three headless runs per request and language, no questions asked; hidden tests, the shared tests and, for a refactor, a shape check score the change.

### Codebases

Lines are non-blank lines of code, tests left out.

| App | What it is | Go lines | Candor lines | Shared tests |
|---|---|---:|---:|---:|
| [ntfy](https://github.com/binwiederhier/ntfy) | pub/sub notification server: HTTP, SQLite, users and ACLs, rate limits | 8,979 | 3,017 | 49 |
| [webhook](https://github.com/adnanh/webhook) | runs commands on HTTP hooks: trigger rules, payloads, signatures | 1,482 | 2,244 | 30 |
| [supercronic](https://github.com/aptible/supercronic) | cron for containers: schedules, time zones, child processes | 1,526 | 1,575 | 30 |

### Requests

Runs that passed: every hidden test, no shared test broken and, for a refactor, the shape
check. Context is the median context the first edit was made in: the docs and code the agent
had read by then, plus Claude Code's own setup, which both languages pay.

| App | Request | Kind | Hidden tests | Go passed | Candor passed | Go context | Candor context |
|---|---|---|---:|---:|---:|---:|---:|
| ntfy | acl-bug: a specific grant overruled by a broader one | bug | 4 | 3/3 | 3/3 | 14k | 13k |
| ntfy | expires: per-message expiry (`X-Expires`) | feature | 6 | 3/3 | 3/3 | 17k | 17k |
| ntfy | topic-limits: topic limits | feature | 6 | 3/3 | 3/3 | 27k | 27k |
| ntfy | user-limits: rate limits per user, not per IP | change | 5 | 3/3 | 3/3 | 24k | 21k |
| ntfy | priority-type: message priority gets a type of its own | refactor | 5 | 2/3 | 3/3 | 19k | 18k |
| webhook | max-concurrent: a per-hook limit on running commands | feature | 8 | 1/3 | 3/3 | 14k | 21k |
| webhook | whitelist-bug: an address refused unless its range comes first | bug | 5 | 3/3 | 3/3 | 12k | 15k |
| webhook | header-object: `response-headers` as an object | change | 5 | 3/3 | 3/3 | 13k | 15k |
| webhook | typed-match: a match rule's type decided when the file is read | refactor | 4 | 3/3 | 3/3 | 17k | 20k |
| supercronic | job-names: name a job with a `# name:` comment | feature | 5 | 3/3 | 3/3 | 13k | 15k |
| supercronic | env-bug: an env value with `=` in it cut short | bug | 4 | 3/3 | 3/3 | 12k | 12k |
| supercronic | exit-code: a failed job's exit code as a log field | change | 5 | 3/3 | 3/3 | 12k | 16k |
| supercronic | options-struct: one options value instead of loose flags | refactor | 4 | 3/3 | 3/3 | 13k | 17k |

### What it took

Medians over every run of a language, the range in brackets.

| | Go | Candor |
|---|---:|---:|
| Runs | 39 | 39 |
| Runs that passed | 36 | 39 |
| Runs that broke a shared test | 0 | 0 |
| Refactors that passed the shape check | 8/9 | 9/9 |
| Context at the first edit | 14k (11k–29k) | 17k (12k–30k) |
| Tokens before the first edit, every call summed | 39k (29k–102k) | 34k (20k–142k) |
| Tokens in all | 164k (54k–411k) | 133k (60k–412k) |
| Turns | 12 | 8 |
| Compiler runs | 8 | 4 |
| Lines changed | 29 | 34 |
| Minutes (see the catches) | 1.7 | 1.2 |
| Cost, all runs | $4.56 | $4.11 |

By kind of request:

| Kind | Go passed | Candor passed | Go context | Candor context | Go tokens | Candor tokens |
|---|---:|---:|---:|---:|---:|---:|
| feature | 10/12 | 12/12 | 15k | 19k | 191k | 196k |
| bug | 9/9 | 9/9 | 12k | 13k | 130k | 78k |
| change | 9/9 | 9/9 | 13k | 16k | 126k | 133k |
| refactor | 8/9 | 9/9 | 17k | 18k | 242k | 151k |

Catches:

- Minutes are measured on a machine shared with other heavy work; read them as rough.
- Go's runs are from 2026-10-28 night; Candor's were run again on 2026-10-31 on Candor 0.0.30, with tests in their own files and the two-part guide. Go doesn't read Candor's docs. Candor's median context at the first edit stayed at 17k (20k on 0.0.29's first runs), Go's is 14k; its tokens in all fell from 155k to 133k, under Go's 164k.
- The Go codebases are idiomatic code by their authors; the Candor ones are ports written by a model, which may suit a model reading them.
- Three runs per request and language is still a small sample; the spread is shown, not hidden.
- Pass rates hardly separate the languages: 36 of 39 Go runs and all 39 Candor runs passed (37 of 39 on 0.0.29). Context is where they differ: Candor's first edit came later in reading on 7 requests of 13 (more than a tenth later), about as early on 5, earlier on 1.
- topic-limits was once the widest gap (35k against 27k), and it was the codebase: the Candor port had left out the topic registry Go's ntfy has, so its runs built one first. With the registry added to the port and topic-limits rerun, it is even. Every Candor run also reads agent.md, about 2k tokens. The widest gaps left (max-concurrent, exit-code, options-struct) are equal work where Candor's way takes more: shared state as a Mutex field of the server, a declared error type in place of Go's wrapped errors, and a bigger test suite in the port. Summing every call's input, as an earlier figure here did, counted early reads again on every call; the dollar gap is smaller still, since cached reads are billed at a tenth.
<!-- /numbers:change -->

### Other agents

The same change requests on one codebase, run by other agents and models, to see whether the
gap between Go and Candor is Claude's or the language's. Sonnet's column is the change trial's
runs from before the shorter guide, so every agent here read the same docs.

<!-- numbers:agents generated from trial-numbers/numbers.json by `bun run numbers` -->
supercronic, Candor 0.0.29, 2026-10-29. Its four change requests, Go and Candor, one headless run each per agent and model (sonnet: the change trial's three from before the shorter guide, the docs the other agents had), scored as in the change trial.

Context is the context the first edit was made in, as in the change trial. Tokens count cache
reads too; an agent's CLI may cache differently, so tokens compare less well than context.

| Agent | Runs | Go passed | Candor passed | Go context | Candor context | Go tokens | Candor tokens | Go turns | Candor turns | Go compiler runs | Candor compiler runs | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Claude Code, `sonnet` | 24 | 12/12 | 12/12 | 13k | 18k | 131k | 147k | 10.5 | 8 | 6.5 | 5 | $2.25 |
| Claude Code, `opus` | 8 | 4/4 | 4/4 | 15k | 26k | 173k | 563k | 13 | 20 | 5 | 6.5 | $3.07 |
| Antigravity, `gemini-4-argon-medium` | 8 | 4/4 | 4/4 | 42k | 66k | 704k | 1917k | 16.5 | 25.5 | 7 | 8.5 | not reported |

Each request, runs passed and context at the first edit:

| Request | Kind | sonnet Go | sonnet Candor | opus Go | opus Candor | gemini-4-argon-medium Go | gemini-4-argon-medium Candor |
|---|---|---:|---:|---:|---:|---:|---:|
| env-bug | bug | 3/3, 12k | 3/3, 12k | 1/1, 13k | 1/1, 21k | 1/1, 37k | 1/1, 44k |
| exit-code | change | 3/3, 12k | 3/3, 20k | 1/1, 19k | 1/1, 23k | 1/1, 64k | 1/1, 66k |
| job-names | feature | 3/3, 13k | 3/3, 16k | 1/1, 17k | 1/1, 30k | 1/1, 47k | 1/1, 66k |
| options-struct | refactor | 3/3, 13k | 3/3, 21k | 1/1, 13k | 1/1, 28k | 1/1, 38k | 1/1, 72k |

Catches:

- Every agent passed every request in both languages, and every agent had taken in more context by its first Candor edit than by its first Go one: sonnet 1.4 times, Opus 1.7, Gemini 1.6. The gap is the language's (or its docs'), not one model's.
- Gemini through Antigravity reads about three times what Claude Code does before its first edit, in both languages; its own setup is about the same size (8k), so that is reading.
- Tokens in all are Candor's widest gap for Opus and Gemini (about 3 times Go's), mostly cached reads over longer runs: more turns and compiler runs in Candor. Sonnet's runs stayed short in both.
- One run per request and language for Opus and Gemini: a single miss would move a pass rate by a quarter. Antigravity reports no cost; Opus cost $3.07 for 8 runs, sonnet $2.25 for 24.
- Antigravity runs headless with an allowlist of its file and shell tools (any path: its rules take an exact path or `*`) and its sandbox. One Gemini run was dropped and run again: the sandbox failed to start a process, and the agent stopped.
<!-- /numbers:agents -->

## Writing from a spec

<!-- numbers:same-spec generated from trial-numbers/numbers.json by `bun run numbers` -->
Claude Code, `sonnet`, Candor 0.0.30, 2026-10-31. One headless run per app and language from the same spec, no questions asked; hidden acceptance tests check the build. The model learns Candor from its docs, in the run.

Lines are non-blank lines written, tests included. Context is the context the agent first
wrote code in: the spec and docs it had read by then, plus Claude Code's own setup.

| App | Tests | Go passed | Candor passed | Go lines | Candor lines | Go compiler runs | Candor compiler runs | Go context | Candor context | Go minutes | Candor minutes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| blobs | 11 | 11/11 | 11/11 | 414 | 330 | 5 | 6 | 10k | 24k | 1.5 | 1.7 |
| bookings | 12 | 12/12 | 12/12 | 383 | 165 | 4 | 2 | 9k | 17k | 1.6 | 0.7 |
| gateway | 11 | 11/11 | 11/11 | 307 | 229 | 4 | 5 | 9k | 22k | 0.9 | 3.6 |
| jobs | 18 | 18/18 | 18/18 | 369 | 361 | 4 | 6 | 10k | 23k | 1.2 | 2.1 |
| logs | 12 | 12/12 | 12/12 | 345 | 311 | 4 | 8 | 10k | 19k | 1.1 | 1.7 |
| pricing | 12 | 12/12 | 12/12 | 288 | 319 | 2 | 3 | 10k | 19k | 0.8 | 1.1 |

Cost, all runs: Go $0.97, Candor $1.41.

Catches:

- Candor pays a reading cost Go doesn't: the model knows Go, and learns Candor from its docs in the run. Before writing code, Candor runs read the guide (docs/agent.md and its service part, about 14 thousand characters; the two that need concurrency read agent-more.md too), the heads of the std modules they use and sometimes an example; Go runs read the spec. That is most of the gap in context and in tokens. A whole service in agent-more.md (2026-10-30) cut the median context from 27k to 24k and the Candor cost from $1.95 to $1.47; on 0.0.30 (2026-10-31) it was 23k and $1.40. The http and json signatures and a shutdown pattern beside that service (2026-10-31) took most of the http and start.md lookups away but made the guide longer by about as much: 22k and $1.47. Moving the service into a part of its own (2026-10-31), so runs writing a service skip concurrency, tests and the std map, gave 20.5k and $1.41: 5 of 6 apps read less, by up to 5k; one run each, so about the noise. The Candor runs here are from 2026-10-31, Go's from 2026-10-29.
- Candor runs wrote fewer lines on four apps of six, tests included, and ran the compiler as often or more: 3 to 8 times, Go 2 to 5.
- One run per app and language: a small sample. Minutes are wall time on a machine shared with other work.
- The 2026-10-26 runs on Kimi Code (Candor 0.0.1) stay in trials/runs, unlisted.
<!-- /numbers:same-spec -->
