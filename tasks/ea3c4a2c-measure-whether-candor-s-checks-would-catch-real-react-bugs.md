---
status: open
area: Design
list: Questions
effort: weekend
created: 2026-11-03
---

# Measure whether Candor's checks would catch real React bugs, before designing a frontend target

From the talk of 2026-11-02. The question: should Candor get a frontend target that compiles to React? Nothing is decided, and docs/design.md has no entry on it. Run after Candor's next milestone: Candor is still changing, and a second front now would slow it. That order is a preference, not a blocker.

Current view, not decided:
- A second target for Candor, not a separate language.
- Compile Candor to readable TSX and import React modules through bindings. The reverse doesn't work: arbitrary JS can't be given honest effects.

What would carry over:
- Effects: render can't have any; only handlers and an explicit effect block get `net`, `storage` or `dom`. That removes a class of `useEffect` bugs.
- Built-in fakes, replacing the MSW, jsdom and fake-timer stack.
- Errors as values: a forgotten loading or error state won't compile.
- The reason to do it at all: one language across the stack, so a frontend test can call the real backend handlers on fake SQL, with no API schema to drift.

Hard parts:
- Drafting bindings from `.d.ts` is much harder than `candor bind` on Go (overloads, conditional types). Effects at that boundary are only declared, not checked.
- Models have seen far more React than anything else, so they start strong.
- Many frontend bugs are visual, and a checker can't catch those.

Scope, no compiler needed:
- Have Sonnet build three or four React apps from a spec, as in the same-spec trial.
- Collect the bugs, and classify each: effect, error or loading state, layout, logic, other.
- Count how many a Candor-style check would have caught at compile time.
- Trials run under the subscription budget, in the trial hours. Pal says when; the side-effect review (#7bf0d715) goes first.

Open for Pal: the share of effect and error-state bugs that makes this worth doing. Agree it before the runs, so the result can't be read to suit.

Done when: the bugs are classified, the share is written here, and Pal has a go or no-go. On a go, the design questions get their own cards here; either way, log the result in docs/design.md.
