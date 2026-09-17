# Fork Plan

Living plan document. See `FORK-HANDOFF.md` for provenance, baseline, and what's already
landed. This file tracks the four bounded slices, their acceptance criteria, and status.

## Ground rules (apply to every slice)

- No tokens, account/auth/settings changes, registry publication (`npm publish` or
  `pkg-pr-new`), production orgs, upstream PRs/issues/comments, global installs, or private
  data, ever.
- No live org exists for this work; every validation-mode / evaluate-path claim must be
  provable with synthetic fixtures and injected transports/spies, not a real Salesforce
  connection.
- Preserve original (non-validation) backend behavior byte-for-byte unless a slice's
  acceptance criteria explicitly requires a change (Slice 2 does; Slice 3 must not touch the
  non-validation code path at all beyond adding the new mode).
- Every commit that changes `src/` must pass, in a plain (non-worktree) clone: `npm run lint`,
  `npm run compile`, `npm run test:unit`, `npm run test:nut`. Run the full offline suite at
  slice boundaries, not after every single edit.

## Slice 1 — Handoff, plan, fork-safe CI

**Status: done.** See `FORK-HANDOFF.md` for what landed (`fork-ci.yml`, gated inherited
workflows, baseline).

## Slice 2 — Score/verdict integrity (false-green prevention)

**Status: done, including a follow-up hardening round.** All four original findings plus four
follow-up findings from a second review pass are fixed, tested, and passing in a plain clone:
lint (197 files), full offline unit suite (104 files / 2155 tests, 100% coverage), NUT suite
(2 files / 62 tests). See `FORK-HANDOFF.md` for the exact commands and file-level summary.

### Follow-up hardening (second review pass, same slice)

1. **The summary fallback itself was still false-green-shaped.** `buildAttributedResult`
   still let a missing per-method row (or the `myMethods.size === 0` no-coverage case) infer
   `Killed` from the overall run's summary outcome — a summary that can be non-Passed for a
   reason entirely unrelated to the mutant in question. Removed entirely: attribution now
   requires a real per-method `Pass` or `Fail`; anything else (`CompileFail`, `Skip`, or a row
   that never reports) is inconclusive and produces `RuntimeError` (reusing that status
   deliberately — same "excluded from score, fails the command" treatment as an infrastructure
   error, for the same reason: no conclusive evidence either way). No-coverage now always means
   `Survived` (nothing could have caught it), never inferred `Killed`.
2. **`hasOperationalErrors` didn't cover zero-valid-mutants.** A run where every mutant failed
   to compile, or where literally nothing was evaluated, produced a plain `0` from
   `calculateScore` — indistinguishable from a legitimately bad score. `hasOperationalErrors`
   now also returns `true` whenever there are zero valid (non-`CompileError`/non-`RuntimeError`)
   mutants, and `run.ts`'s `error.scoreUnavailable` message names which case applies (no
   mutants evaluated at all / all evaluated mutants failed to compile / N of M hit an
   operational error).
3. **A real bug: `undefined` entries could survive into the report.** `executeMutationLoop`
   assigned `orderedResults[idx] = mutantResults[i]` for every index in `group.mutations`, but
   a mid-group abort (`recurseIntoSingletons` stopping after a child throws) returns fewer
   entries than that — the excess indices got `mutantResults[i] === undefined` written in,
   and `isPresent`'s `value !== null` check let `undefined` through the final filter. Fixed to
   only assign as many indices as `mutantResults` actually holds, leaving the rest at their
   `null` default. Also added `ApexMutationTestResult.incomplete` (`{evaluatedCount,
   plannedCount}`, only present when a real shortfall exists — an abort on the last group with
   nothing left over is not "incomplete"): surfaced via `this.warn` in the CLI, a banner in the
   HTML report, and `config.incomplete` in the report's JSON data island. Regression-tested at
   both the `GroupExecutor` unit level (exact call-count proof) and end-to-end through
   `MutationTestingService.process()` into the real (non-mocked) `HTMLReporter` — proving the
   partial result never crashes the reporter, not just that the executor's return value looks
   right in isolation.
4. **Report file was mode 0644 (world-readable).** It embeds the full class source plus every
   covering test's identity. Changed the atomic-write default to `0600`; proven against a real
   filesystem stat, not a mocked `writeFile` argument (`HTMLReporter.symlinkSafety.test.ts`).

### Confirmed findings (traced to source at `c3f95db`, each independently reproduced)

1. **RuntimeError counted as Killed (the headline false-green bug).**
   `MutationTestingService.calculateScore` (`src/service/mutationTestingService.ts:281-294`)
   puts `'RuntimeError'` in `killedStatuses`. `RuntimeError` is only ever produced by
   `groupExecutor.ts`'s `classifyRuntimeError`, reached only when `OrgMutationTestBed.evaluate`
   throws something that isn't a `DeploymentFailedError` — i.e. an infrastructure failure
   (network, poll timeout, auth/session, exhausted async-test quota), never a genuine Apex
   test signal (a governor-limit exception already scores `Killed` through the ordinary
   failing-test-row path and never reaches this classifier — traced and confirmed, see
   `DESIGN.md`'s Structured Error Classification section and
   `src/adapter/org/orgMutationTestBed.ts:61-82`).
   - **Fix:** exclude `RuntimeError` from the valid-mutant denominator, matching
     `CompileError` and matching the real Stryker/`mutation-testing-metrics` semantics this
     report format claims to speak (`totalInvalid = runtimeErrors + compileErrors`, never in
     `totalDetected`).
   - **Fix:** when any mutant is `RuntimeError`, the CLI command must not silently report a
     (deflated-but-plausible) numeric score and exit 0/1 on the threshold alone — it must
     report the score as unavailable and fail the command outright, regardless of whether the
     remaining (real) evidence would have cleared the configured threshold. Operational
     failures must never let a run "pass" and must never masquerade as a normal
     threshold-miss either. The full per-mutant detail (including each `RuntimeError`'s
     `statusReason`) still reaches the HTML/JSON report — the report is written before this
     check runs — only the score/exit-code semantics change.
   - **Preserve:** an actual failing Apex test row (governor limit or otherwise) still scores
     `Killed` through `attributeOutcomes`/`buildAttributedResult`, untouched by this fix.

2. **Grouped-batch circuit breaker.** `GroupExecutor.evaluateGroup`
   (`src/service/groupExecutor.ts:146-206`) recurses into per-mutation singleton re-evaluation
   for *any* non-`'executed'` outcome at `k > 1`, including `{ kind: 'threw' }`. Since every
   `'threw'` outcome is, by the trace above, an infrastructure failure, retrying it N times as
   singletons (a) burns N further doomed API calls against an org that just failed, and (b)
   — before the Slice 2 fix 1 lands — would have multiplied the false-green blast radius (one
   auth failure marking an entire group's mutants "killed" instead of one). Fix: classify a
   `'threw'` outcome for the *whole group* directly (no singleton retry, no further calls) and
   stop evaluating remaining groups in the same run once one is observed (same failure will
   recur). Recursion into singletons is preserved for `not-compilable` and coverage-gap
   outcomes — those are legitimately per-mutation-dependent, not infrastructure-wide.

3. **Terminal test-outcome misclassification in `buildAttributedResult`.**
   `GroupExecutor.buildAttributedResult` (`src/service/groupExecutor.ts:264-301`) treats any
   reported outcome `!== 'Pass'` as a kill signal. `@salesforce/apex-node`'s `ApexTestResultOutcome`
   includes non-terminal/non-adjudicating rows (e.g. a compile-failed or skipped/aborted
   method row folded into `tests[]`) that are not evidence the mutant was actually exercised
   and killed. Needs a terminal-outcome allowlist so only a real executed failing assertion
   (or an ordinary `Fail`) kills, and anything else (compile-fail/skip/abort/unknown at the
   per-method level) is treated as incomplete evidence rather than a kill — without touching
   the existing, correct handling of an actual failing test row. **Verify exact
   `@salesforce/apex-node` outcome enum spellings before coding this** — do not invent
   synthetic outcome names.

4. **`HTMLReporter` output-path symlink following.** `generateReport`
   (`src/reporter/HTMLReporter.ts:58-78`) validates the *directory* is real-path-safe
   (`resolveSafeOutputDir` + `assertRealPathWithinCwd`) but writes the *file*
   (`writeFile(path.join(resolvedDir, 'index.html'), ...)`) without checking whether
   `index.html` itself is a symlink — a `reports/index.html -> /outside/target` symlink planted
   before the run gets its target overwritten. Needs the same atomic-write protection pattern
   (write to a temp file in the same directory, then rename; refuse if the final path is a
   symlink) — this is a natural, narrow adaptation from the donor's own output-protection
   work, not a bulk copy; attribute the donor file if code is lifted nearly verbatim (see
   `FORK-HANDOFF.md`'s Copied-file attribution section).

### Acceptance for Slice 2 (all met, proven by tests below, not assertion)

- ✅ Every `evaluate()` call rejecting with an auth/network/timeout-shaped error → the command
  reports score-unavailable and fails, regardless of the configured threshold.
  `mutationTestingService.hasOperationalErrors` + `run.ts`'s `error.scoreUnavailable` throw;
  `test/nut/run.nut.test.ts` "Given a mutant hit an operational (infrastructure) error".
- ✅ A run mixing genuine kills with even one operational error → command fails (never passes
  on the strength of the real kills alone) — operational failures are not "partial credit".
  Report still lists every mutant's real status (report is published before the check runs).
  Same test file, "the real evidence alone would clear" case (asserts fail despite score 100
  on the real evidence).
- ✅ A genuine Apex test failure (ordinary `Fail` row, including a governor-limit row) still
  scores `Killed` — unchanged; `groupExecutor.test.ts`'s existing Fail-row-attribution test
  still passes untouched.
- ✅ Circuit breaker call counts are asserted exactly: a grouped batch that throws makes
  exactly one deploy/test-run attempt for that group, zero singleton retries, and zero further
  groups are attempted afterward (spy-verified request counts via `evaluateMock`, not
  timing-based) — `groupExecutor.test.ts`'s two new circuit-breaker tests (top-level throw, and
  a throw mid-recursion after a `not-compilable` verdict, the latter proving the "stop
  immediately" behavior applies inside the singleton fallback too, not only at the top).
- ✅ Terminal-outcome allowlist: `buildAttributedResult` kills only on a real `Fail`; a
  `CompileFail`/`Skip` per-method row is "completed but not a kill", never conflated with a
  genuinely missing row (which still uses the pre-existing summary fallback, untouched).
- ✅ `HTMLReporter` writes atomically (temp file + `rename`) and is symlink-safe by
  construction — proven against a real filesystem symlink (`HTMLReporter.symlinkSafety.test.ts`,
  no mocks), plus mocked failure-path tests for the write/cleanup error handling.
- ✅ CLI text output, `--json` output, and the HTML report agree on which mutants are
  score-eligible; no path can compute a numeric score while operational errors exist (the CLI
  throws before `calculateScore`'s result is ever surfaced when `hasOperationalErrors` is true).
- ✅ Full offline suite green in a plain (non-worktree) clone: `lint` (197 files), `compile`,
  `test:unit` (104 files / 2148 tests, 100% branch/function/line/statement coverage),
  `test:nut` (2 files / 59 tests). `npm run test:mutation` was not run — expensive by design,
  not repeated per the ground rules above; nothing in this slice's fix set depends on it for
  proof, since every behavior change has a direct, deterministic unit/NUT regression test.

## Slice 3 — Validation-only backend (status: not started)

Add an explicit validation/check-only mode through `MutationTestBed`/`EngineBundle`, distinct
from upstream's existing `--dry-run` (which still means "estimate only, no deploy at all").
Validation mode performs a **check-only deployment with tests** (Metadata API
`checkOnly: true`, `IsRunTests: true` via `ContainerAsyncRequest`, or the tooling-API
equivalent) for both the baseline and every mutant — never a real (non-check-only) update,
never the original-backend `restore()`/rollback path, including the grouping-fallback cleanup
path. No silent fallback to the real backend on any unsupported feature — an incompatible
combination (e.g. grouping, if per-method attribution can't be proven safe under check-only
semantics) must produce a clear, typed error, not a silent behavior change.

Key open question to resolve before writing code: how `RunSpecifiedTests` maps under
check-only — upstream's per-method `TestMethodId` (`classId.methodName`) selection assumes a
real deploy's Metadata API deploy-with-tests semantics; confirm whether check-only deploys
support the same per-method `RunSpecifiedTests` selection or only class-level "run these
classes" semantics, and if the latter, do not claim per-method attribution the backend can't
actually prove — gate/error instead of inventing coverage.

Baseline and per-mutant strictness for validation mode: require a *completed* check-only
result with `checkOnly: true` and positive executed-test evidence; malformed/auth-failed/
zero-tests-executed/coverage-only/compile-failed/failing-baseline outcomes all stop before any
mutant is evaluated, same spirit as Slice 2's operational-error handling but enforced at the
validation-mode boundary specifically.

Will use narrow, explicit interface extensions to the existing ports where necessary (not a
parallel copy of the whole backend) and adapt (not bulk-copy) the donor's isolated-source /
bounded-process / atomic-output / org-safety patterns where they still apply to upstream's
architecture. Proven with spies and an injected transport — no live org, ever.

## Slice 4 — Output/symlink protection, preflight diagnostics, plugin smoke tests, README

**Status: not started** (Slice 2 finding 4 above is the output/symlink item and will land as
part of Slice 2 since it's a small, self-contained fix; the rest of Slice 4 — preflight
diagnostics, installed-tarball/plugin smoke tests, README fork-clarity edits, and the
technical-review brief — comes after Slice 3).

## Non-goals for this phase

No tagged release. No npm publish. No pkg-pr-new preview. No claim of Salesforce/Windows live
acceptance. No repeat of the full mutation-testing (`npm run test:mutation`) or perf
(`npm run test:perf`) suites beyond what a specific regression needs to prove.
