# Fork Handoff

## Provenance

- **This fork**: `JoshuaStorm1017/apex-mutation-testing` (public, private-work-in-progress
  content, MIT-licensed same as upstream).
- **Upstream**: `scolladon/apex-mutation-testing`, MIT License, Copyright (c) 2025 Sebastien
  Colladon (`LICENSE.md`, unmodified — do not alter the copyright line; new fork-only files
  add their own notice only where they substantively copy donor code, see "Copied-file
  attribution" below).
- **Fork base commit**: `c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc` (`chore(main): release
  1.9.1 (#166)`).
- **Donor** (read-only reference, not a dependency): `apex-mutant`, a standalone Apex mutation
  testing CLI built independently before this fork existed
  (`/Users/joshstorm/Projects/apex-mutant/.claude/worktrees/apex-mutant-claude-work` at
  `04e93f1`, MIT-equivalent, same author). Its `HANDOFF`/`REVIEW-NOTES` describe 73 offline
  tests and an `alpha.2` state. The donor is **not** vendored wholesale — this fork adapts
  specific ideas (validation-only/check-only deploy, output/symlink protection, preflight
  diagnostics) into upstream's own architecture and conventions, never a bulk copy of the
  donor's CLI.
- **Decision**: build on Scolladon's upstream (mature, actively maintained, much more
  thoroughly designed — see `DESIGN.md`) rather than continue the standalone donor project.
  Port the donor's validation-only/safety ideas into upstream where they add real value;
  upstream's own error-classification/scoring architecture turned out to need its own fixes
  independent of the donor (see Slice 2 below) — those are native fixes to upstream at
  `c3f95db`, not ports.

## No claims of superiority

This fork is **not** claimed to be superior to upstream at any point during this work. It is
upstream plus (a) two verified scoring/attribution correctness fixes upstream doesn't have yet
(Slice 2), (b) an experimental validation-only backend gated behind an explicit flag (Slice 3,
in progress), and (c) fork-safe CI/packaging hygiene (Slice 1, this document). Everything else
is unchanged upstream behavior.

## Baseline (recorded before any source change, base commit `c3f95db`)

Toolchain: upstream's `package.json` pins `engines.node: "^22.22 || ^24.15 || >=26"` and
`engines.npm: ">=12"` — newer than this host's default (`node v24.2.0` / bundled `npm
11.19.0`, neither satisfies the range). Used a project-local, non-global runtime instead:
Node `v24.21.0` (official darwin-arm64 tarball, extracted to a scratch directory, never
installed system-wide) with `npm` upgraded to `12.0.2` inside that same scratch prefix (also
not global — `npm install -g npm@latest --prefix <scratch-dir>`, isolated to that one
directory's `bin/`). No global install, no weakened `engines` field.

**Known local-dev-only toolchain quirk (not a fork bug, not a CI risk):** running
`vitest`/Vite's Oxc-based test transform from *inside a git worktree*
(`.claude/worktrees/...`) makes Oxc's native tsconfig-project discovery resolve `extends`
relative to the **main checkout's** directory (three levels up) instead of the worktree's own
— confirmed by planting a uniquely-named marker path in the main checkout's `tsconfig.json`
and watching the transform error name that exact relative path. This only affects local
development done inside a linked worktree; a normal `git clone` (which is what
`actions/checkout` does, and what any contributor's own clone is) never exhibits it. Verified
by cloning the worktree's commit into a plain scratch clone and running the full suite there
— clean pass, see below. No source or config change was made for this; it needs no fix here.

Baseline results (recorded in a plain clone of `c3f95db`, Node v24.21.0 / npm 12.0.2):

| Check | Result |
| --- | --- |
| `npm ci` | clean, 908 packages, 0 errors (8 pre-existing moderate/high advisories, unrelated to this work, not remediated here) |
| `npm run compile` (`tsc -p .`) | pass |
| `npm run lint` (biome, 196 files) | pass, 0 issues |
| `npm run test:unit` (`vitest run --coverage`) | **103 test files / 2136 tests, all passed** |
| `npm run test:nut` | **2 test files / 56 tests, all passed** |

No e2e (`test:e2e:*`) or mutation (`test:mutation`) suite was run — both need a live org or are
expensive-by-design; out of scope per the no-live-org constraint. `test:perf` was not run
(non-deterministic, advisory-only upstream, not relevant to correctness work).

## Slice 1 — this document, `FORK-PLAN.md`, fork-safe CI

- Added `.github/workflows/fork-ci.yml`: offline lint/compile/unit/NUT/`npm pack` on every
  push/PR to this fork's `main`, no org auth, no publish, no gh-pages write, no PR comment.
- Gated every inherited workflow job that publishes, comments, or writes shared state behind
  `github.repository == 'scolladon/apex-mutation-testing'` so none of them can fire in this
  fork even by accident (an opened PR, a pushed tag, a GitHub Release): `perf` and `preview`
  and `comment` and `e2e-tests` in `on-pull-request.yml`; `prepare-release` and `perf` in
  `on-main-push.yml`; the whole of `npm-service.yml` (the actual `npm publish` job) and
  `on-published-release.yml`. The files are kept (not deleted) so a future upstream merge
  stays low-conflict; only an `if:` guard was added to each job.
- No tagged release, no npm publish, no pkg-pr-new preview, no upstream PR/issue/comment, no
  production-org or scratch-org connection was made or attempted at any point in this session.

## Copied-file attribution

Nothing has been copied verbatim from the donor (`apex-mutant`) into this fork yet. Slice 2's
fixes below are native corrections to upstream's own `c3f95db` source, independently traced
and verified against upstream's own `DESIGN.md` and the real
`mutation-testing-metrics`/Stryker schema semantics — not ports. If/when Slice 3 or 4 lifts a
substantive donor implementation (e.g. symlink-safe atomic output writing, a preflight
diagnostics shape), this section will name the donor file, the fork file it lands in, and add
the donor's MIT notice to that file's header, per the task's licensing requirement.

## Slice 2 — score/verdict integrity (status: in progress, see `FORK-PLAN.md`)

Traced upstream's verdict taxonomy end-to-end at `c3f95db` and found a real false-green
scoring defect, independent of anything in the donor:

`src/service/mutationTestingService.ts`'s `calculateScore` treats mutant status
`'RuntimeError'` as killed (`killedStatuses = new Set(['Killed', 'RuntimeError'])`, excluded
only `'CompileError'` from the denominator). `RuntimeError` is minted in
`src/service/groupExecutor.ts`'s `classifyRuntimeError`, which — traced through
`OrgMutationTestBed.evaluate` (`src/adapter/org/orgMutationTestBed.ts`) — is reached **only**
by an error thrown from the mutant deploy or test-run call that is *not* a
`DeploymentFailedError` (compile failures are already data, not exceptions, per ADR 087). By
construction, every such thrown error is an infrastructure failure: a network error, a
`PollTimeoutError`, an expired/invalid session, an exhausted `DailyAsyncApexTests` quota — see
the existing unit test at `test/unit/service/mutationTestingService.test.ts:441-457`, whose
own fixture for `RuntimeError` is literally an expired-session-token auth error, and whose
adjoining `expectedScore` case (`test/unit/service/mutationTestingService.test.ts:2847-2851`)
asserts that **two mutants that only ever hit an auth error score 100%**. This is the exact
false-green failure mode this fork exists to close, present natively in upstream at
`c3f95db`, unrelated to the donor.

Cross-checked against the real Stryker semantics this report format claims to implement
(`node_modules/mutation-testing-metrics/dist/src/calculateMetrics.js`): `RuntimeError` is
`totalInvalid`, alongside `CompileError` — never counted toward `totalDetected`. Upstream's
own scoring formula disagrees with the schema it emits.

**Status: done.** Four findings fixed and tested (full detail and file-level notes in
`FORK-PLAN.md`):

1. `calculateScore` now excludes `RuntimeError` from the valid-mutant denominator (matching
   `CompileError` and the real Stryker/`mutation-testing-metrics` semantics), and
   `run.ts` fails the command outright — via a new `hasOperationalErrors` check and
   `error.scoreUnavailable` — whenever any mutant is `RuntimeError`, regardless of the
   configured threshold or how the real evidence alone would have scored.
2. `GroupExecutor` circuit-breaks on a thrown (`'threw'`) outcome: classifies the whole group
   in one shot with zero further calls, and signals `executeMutationLoop` to stop evaluating
   remaining groups — including mid-recursion, when a singleton retry (triggered by an
   unrelated `not-compilable`/coverage-gap ambiguity) itself throws.
3. `buildAttributedResult`'s per-method kill check is now an allowlist (`outcome ===
   'Fail'`, matching `@salesforce/apex-node`'s real `ApexTestResultOutcome` enum) rather than
   a denylist (`outcome !== 'Pass'`) — a `CompileFail` or `Skip` row no longer counts as a
   kill.
4. `HTMLReporter.generateReport` writes to a temp file and `rename`s it onto the final path
   (atomic, and symlink-safe by construction — `rename()` never follows a symlink at its
   destination) instead of writing through the final path directly.

Findings 1 and 2 were traced independently from `DESIGN.md` and source, cross-checked against
`node_modules/mutation-testing-metrics`'s real scoring semantics, and further sharpened by a
Codex ("Sol") read-only review Josh commissioned in parallel on the same source paths (score
taxonomy and the grouping/attribution seams); its guidance on the circuit-breaker's call-count
behavior and on not repeating expensive suites unnecessarily is reflected above. Findings 3
and 4 came from a separate Codex quick-review pass against the compiled `lib/` in disposable
fixtures (no org, no source edits) — verified independently here against the real
`@salesforce/apex-node` `ApexTestResultOutcome` enum (`Pass`/`Fail`/`CompileFail`/`Skip` — no
`Aborted` value exists in this SDK version, so the fix does not invent one) before coding.

Proof, in a plain (non-worktree) clone at the commit landing this fix: `npm run lint` (197
files), `npm run compile`, `npm run test:unit` (104 files / 2148 tests, 100% branch/function/
line/statement coverage — up from the 103/2136 baseline), `npm run test:nut` (2 files / 59
tests — up from 2/56). `HTMLReporter.symlinkSafety.test.ts` is a new, deliberately
un-mocked-fs test proving the symlink fix against a real filesystem symlink, not just a mocked
`realpath`.
