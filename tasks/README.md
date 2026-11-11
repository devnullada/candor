# Tasks

One file per card, named by its id: cite a card as #<id> in commits and docs/design.md. A card's
`area` and `list` are the headings below.
`blocked-by` lists the cards it waits on. Done cards are deleted, their commit says what was done.

## Candor trials

### Change trials

- [Calibrate Opus runs against the subscription on supercronic](98028f3f-calibrate-opus-runs-against-the-subscription-on-supercronic.md) (evening)
- [Build the side-effect review trial](7bf0d715-build-the-side-effect-review-trial.md) (evening)
- [Run supercronic's change requests on Kimi beside the other agents](5a966254-run-supercronic-s-change-requests-on-kimi-beside-the-other-a.md) (evening)
- [Add a 15k-line codebase to the change trial, with cross-module requests](cc83cca1-add-a-15k-line-codebase-to-the-change-trial-with-cross-modul.md) (bigger)
- [Compare Candor and Rust on a port of a real FastAPI service](ff3be7bb-compare-candor-and-rust-on-a-port-of-a-real-fastapi-service.md) (bigger)

## Repo

### Repo

- [Move the open cards to GitHub issues](2154c848-move-the-open-board-cards-to-github-issues.md) (evening)

## Tooling

### VS Code extension

- [Highlight Candor in VS Code: TextMate grammar and language config](4986323e-highlight-candor-in-vs-code-textmate-grammar-and-language-co.md) (weekend)
- [Show diagnostics in VS Code through `candor lsp`](4d63b50b-show-diagnostics-in-vs-code-through-candor-lsp.md) (weekend)
- [Attach structured fixes to diagnostics and offer them as quick fixes](4e17d18b-attach-structured-fixes-to-diagnostics-and-offer-them-as-qui.md) (weekend)
- [Recover from syntax errors so one typo doesn't hide every type error](5412a362-recover-from-syntax-errors-so-one-typo-doesn-t-hide-every-ty.md) (weekend)
- [Hover types and go to definition from the checker's index](4486d0ca-hover-types-and-go-to-definition-from-the-checker-s-index.md) (bigger)
- [Run Candor tests from the editor](9ff51f7a-run-candor-tests-from-the-editor.md) (weekend)
- [Show each call's effects in the editor](f27db8ee-show-each-call-s-effects-in-the-editor.md) (weekend)

### Other editors

- [Support Cursor and Windsurf with the VS Code extension](6e253e5b-support-cursor-and-windsurf-with-the-vs-code-extension.md) (evening)
- [Write a Zed extension for Candor](04fe6f2b-write-a-zed-extension-for-candor.md) (evening)
- [Set up Neovim and Helix for Candor](a4ad6674-set-up-neovim-and-helix-for-candor.md) (evening)
- [Support JetBrains IDEs through LSP4IJ](c89ba866-support-jetbrains-ides-through-lsp4ij.md) (weekend)

### Highlighters

- [Write a tree-sitter grammar for Candor](e8e196bb-write-a-tree-sitter-grammar-for-candor.md) (weekend)
- [Write a highlight.js language definition for Candor](78930665-write-a-highlight-js-language-definition-for-candor.md) (evening)
- [Get Candor into GitHub Linguist](5e531953-get-candor-into-github-linguist.md) (evening)
- [Write a CodeMirror mode for Candor](5216fc47-write-a-codemirror-mode-for-candor.md) (evening)

### Agents

- [Publish the Candor skill for Claude Code](13bea955-publish-the-candor-skill-for-claude-code.md) (evening)
- [Give GitHub Copilot the Candor instructions and MCP](ddab6f3e-give-github-copilot-the-candor-instructions-and-mcp.md) (evening)
- [Write a Gemini CLI extension for Candor](4125478f-write-a-gemini-cli-extension-for-candor.md) (evening)
- [Make AGENTS.md and llms.txt enough for any other agent](0ead72a3-make-agents-md-and-llms-txt-enough-for-any-other-agent.md) (evening)

### CI and governance

- [Fail CI when effects drift from a committed effects.lock](768dd00d-fail-ci-when-effects-drift-from-a-committed-effects-lock.md) (evening)
- [Record every extern and Go package in effects.lock](9bc03dc7-record-every-extern-and-go-package-in-effects-lock.md) (evening)
- [Enforce effect rules from a policy file](ffa8eceb-enforce-effect-rules-from-a-policy-file.md) (weekend)
- [Show Candor's check results on pull requests](8008c4ed-show-candor-s-check-results-on-pull-requests.md) (evening)
- [Publish a candor-check GitHub Action](c05486b6-publish-a-candor-check-github-action.md) (evening)

### CLI

- [Restart a running program on code changes with `candor run --watch`](219088f8-restart-a-running-program-on-code-changes-with-candor-run-wa.md) (evening)

## Modules

### Todo

- [Support Postgres in sql](e6f954cc-support-postgres-in-sql.md) (bigger)
- [Move the generated go.mod up from `go 1.22`](adbad59f-move-the-generated-go-mod-up-from-go-1-22.md) (evening)

## Design

### Questions

- [Measure whether Candor's checks would catch real React bugs, before designing a frontend target](ea3c4a2c-measure-whether-candor-s-checks-would-catch-real-react-bugs.md) (weekend)
