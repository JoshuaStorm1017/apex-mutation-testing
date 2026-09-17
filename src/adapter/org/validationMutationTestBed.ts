import type {
  DeployMessage,
  DeployResult,
  RunTestsResult,
} from '@jsforce/jsforce-node/lib/api/metadata/schema.js'
import { Connection } from '@salesforce/core'
import {
  type Baseline,
  CompilationCheckFailedError,
  type MutantVerdict,
  type MutationTestBed,
  type PrepareHooks,
  type RestorePolicy,
} from '../../port/mutationTestBed.js'
import {
  AggregateCoverageStrategy,
  PerTestCoverageStrategy,
} from '../../service/coverageStrategy.js'
import { timeExecution } from '../../service/timeUtils.js'
import type { ApexClass } from '../../type/ApexClass.js'
import type {
  ApexTestMethodResult,
  ApexTestRunResult,
} from '../../type/ApexTestRunResult.js'
import type { TestMethodId } from '../../type/TestMethodId.js'
import { ApexSettingsRepository } from './apexSettingsRepository.js'
import { ApexTestRunner } from './apexTestRunner.js'
import { OrganizationRepository } from './organizationRepository.js'
import { buildValidationDeployPackage } from './validationDeployPackage.js'

// Refuses validation mode against anything that isn't a sandbox or scratch
// org, before any deploy is attempted. Distinct from every other error this
// bed raises: this one fires before prepare() does any org write, and it is
// never a compile or test result — it is an org-safety gate, and the only
// one this bed adds beyond what the original (Tooling API) backend already
// relies on.
export class ValidationModeProductionOrgError extends Error {
  constructor() {
    super(
      'Validation mode refuses to run against a production org (or an org whose sandbox status could not be confirmed). ' +
        'It is intended for sandbox and scratch orgs only.'
    )
    this.name = 'ValidationModeProductionOrgError'
  }
}

// Raised when the check-only deploy itself — not a compile or test outcome —
// did not produce trustworthy evidence: a non-terminal result, a result that
// somehow was not checkOnly (a hard invariant this bed never relaxes), a run
// where tests were not actually enabled, or missing/inconsistent test-run
// counts. Every one of these means "we cannot tell what happened", which is
// different from "we tried and it failed" (CompilationCheckFailedError, or a
// genuine test failure folded into Baseline.otherFailureCount) — see
// DESIGN.md's validation-mode section for the taxonomy this keeps distinct.
export class ValidationDeployInconclusiveError extends Error {
  constructor(reason: string, result: Pick<DeployResult, 'id' | 'status'>) {
    super(
      `Validation deploy ${result.id} (status: ${result.status}) produced no trustworthy evidence: ${reason}`
    )
    this.name = 'ValidationDeployInconclusiveError'
  }
}

const formatComponentFailures = (failures: DeployMessage[]): string =>
  failures
    .map(
      m =>
        `[${m.fileName}${m.lineNumber ? `:${m.lineNumber}:${m.columnNumber ?? 0}` : ''}] ${m.problem ?? 'Unknown error'}`
    )
    .join('\n')

// Maps the Metadata API's RunTestsResult into this plugin's own domain shape
// — the same ApexTestRunResult the Tooling API transport produces (see
// apexTestRunner.ts's toApexTestRunResult) — so GroupExecutor's existing
// attribution logic (buildAttributedResult's Pass/Fail allowlist) consumes
// either transport identically, unaware which one ran.
//
// classCoverage is deliberately NOT populated from RunTestsResult.codeCoverage
// here: CodeCoverageResult reports `locationsNotCovered` and a total
// `numLocations` count, never the covered line numbers themselves, so there
// is no honest way to derive a `coveredLines: number[]` array from it. Doing
// so would mean inventing coverage data — exactly what this fork exists to
// refuse to do. Coverage instead comes from the existing, unmodified
// ApexTestRunner.getTestMethodsPerLines() read in prepare() below, which
// queries the org's real (Tooling API) coverage records directly, entirely
// independent of this deploy.
const toApexTestRunResult = (
  runTestResult: RunTestsResult
): ApexTestRunResult => ({
  outcome: runTestResult.numFailures > 0 ? 'Failed' : 'Passed',
  tests: [
    ...runTestResult.successes.map(
      (s): ApexTestMethodResult => ({
        classId: s.id,
        methodName: s.methodName,
        outcome: 'Pass',
      })
    ),
    ...runTestResult.failures.map(
      (f): ApexTestMethodResult => ({
        classId: f.id,
        // A RunTestFailure can in principle omit methodName (the schema
        // marks it optional) for a class-level failure that never reached a
        // specific method. Falling back to a sentinel rather than `null`
        // keeps ApexTestMethodResult's `methodName: string` contract intact
        // without qualifying a method identity that does not exist —
        // nothing downstream looks this row up by name, since it never
        // matches a real covering TestMethodId.
        methodName: f.methodName ?? '<class-level failure>',
        outcome: 'Fail',
      })
    ),
  ],
})

// The validation-mode counterpart to OrgMutationTestBed (orgMutationTestBed.ts).
// Implements the same MutationTestBed port — GroupExecutor and
// MutationTestingService consume either through the identical interface and
// never know which one is wired in (see orgEngine.ts / a future
// createValidationOrgEngine for the wiring) — but every deploy this bed
// issues is a Metadata API check-only deploy (`checkOnly: true`, asserted
// after every call, never just assumed), never a real one, and restore() is
// an explicit no-op: a check-only deploy is never committed, so there is
// nothing to roll back. See FORK-PLAN.md's Slice 3 section for the full
// design rationale, including the fidelity/cost tradeoffs this simplifies
// away for a first version (no per-mutant test narrowing, no grouping — see
// mutationTestingService.ts's grouping-rejection guard for validation mode).
export class ValidationOrgMutationTestBed implements MutationTestBed {
  private original: ApexClass | undefined
  private perimeter: string[] = []

  constructor(
    private readonly connection: Connection,
    private readonly apexTestRunner: ApexTestRunner,
    private readonly organizationRepository: OrganizationRepository,
    private readonly settings: ApexSettingsRepository
  ) {}

  public async prepare(
    original: ApexClass,
    perimeter: string[],
    hooks: PrepareHooks
  ): Promise<Baseline> {
    if (!(await this.organizationRepository.isSandbox())) {
      throw new ValidationModeProductionOrgError()
    }
    this.original = original
    // De-duplicated defensively: ConfigReader.normalizeClassPerimeter already
    // dedupes the CLI/config perimeter upstream, but this bed's own
    // `runTests` selection is a second, independent place that value is
    // used, and a duplicate class name is otherwise harmless to send twice —
    // silently accepting it rather than asserting keeps this bed from being
    // the one place a perimeter that was fine everywhere else starts
    // throwing.
    this.perimeter = [...new Set(perimeter)]

    hooks.onVerifying()
    const { result: deployResult, durationMs: applyMs } = await timeExecution(
      () => this.checkOnlyDeploy(this.requireOriginal().Id, original.Body)
    )
    hooks.onVerified()

    this.assertTrustworthy(deployResult)
    if (deployResult.numberComponentErrors > 0) {
      throw new CompilationCheckFailedError(
        new Error(
          formatComponentFailures(deployResult.details.componentFailures)
        )
      )
    }

    const strategy = (await this.settings.isAggregateCoverageOnly())
      ? new AggregateCoverageStrategy(original.Id)
      : new PerTestCoverageStrategy(original.Id)

    hooks.onBaselineStarting()
    // Real coverage, read-only: the org's own Tooling API coverage records,
    // entirely independent of the check-only deploy above. Never touches or
    // relies on RunTestsResult.codeCoverage — see toApexTestRunResult's
    // comment for why that field cannot honestly produce this.
    const { result: coverageRead, durationMs: runMs } = await timeExecution(
      () => this.apexTestRunner.getTestMethodsPerLines(this.perimeter, strategy)
    )
    const runTestResult = deployResult.details.runTestResult!

    return {
      outcome: runTestResult.numFailures > 0 ? 'Failed' : 'Passed',
      testsRan: runTestResult.numTestsRun,
      compileFailures: [],
      otherFailureCount: runTestResult.numFailures,
      testMethodsPerLine: coverageRead.testMethodsPerLine,
      fidelity: strategy.fidelity,
      cost: { applyMs, runMs },
    }
  }

  public async evaluate(
    mutatedBody: string,
    _tests: ReadonlySet<TestMethodId>
  ): Promise<MutantVerdict> {
    // The Metadata API's checkOnly deploy selects tests at class granularity
    // only (DeployOptions.runTests: string[] names classes, never methods —
    // there is no per-method equivalent of the Tooling API's TestItem[]
    // here). `_tests` — the specific covering methods GroupExecutor computed
    // for this mutant — is therefore not narrowed into the deploy request;
    // every evaluate() call re-runs the bed's full test perimeter. This is a
    // real cost/fidelity reduction versus the original backend's per-mutant
    // targeting, not a bug: attribution correctness is unaffected, because
    // GroupExecutor still reads only the covering methods' own outcomes back
    // out of whatever ran (see mapMutant/buildAttributedResult) — the extra
    // methods that ran are simply present in the result and never consulted.
    const deployResult = await this.checkOnlyDeploy(
      this.requireOriginal().Id,
      mutatedBody
    )
    this.assertTrustworthy(deployResult)
    if (deployResult.numberComponentErrors > 0) {
      return {
        kind: 'not-compilable',
        detail: `Deployment failed:\n${formatComponentFailures(deployResult.details.componentFailures)}`,
      }
    }
    return {
      kind: 'executed',
      result: toApexTestRunResult(deployResult.details.runTestResult!),
    }
  }

  // A check-only deploy is never committed by the org, so there is nothing
  // to roll back — this is an explicit no-op, not an omission. Callers
  // (executeMutationLoopWithRollback's success and failure paths alike) call
  // this exactly as they would against the original backend; it simply has
  // no work to do. See validationMutationTestBed.test.ts for the spy proof
  // that this never issues a real (non-checkOnly) deploy on any path,
  // including the failure path and the grouping-fallback recursion.
  public async restore(_policy: RestorePolicy): Promise<void> {
    return
  }

  private async checkOnlyDeploy(
    className: string,
    body: string
  ): Promise<DeployResult> {
    const zip = await buildValidationDeployPackage(
      className,
      body,
      this.connection.version
    )
    const locator = this.connection.metadata.deploy(zip, {
      checkOnly: true,
      testLevel: 'RunSpecifiedTests',
      runTests: this.perimeter,
      rollbackOnError: true,
      singlePackage: true,
      ignoreWarnings: true,
    })
    return locator.complete(true)
  }

  // No silent fallback: every field this bed's callers rely on for scoring
  // is asserted here, once, before either caller (prepare or evaluate) reads
  // any of them. A result that fails any of these checks throws
  // ValidationDeployInconclusiveError rather than being interpreted as a
  // pass, a fail, or anything in between.
  private assertTrustworthy(result: DeployResult): void {
    if (!result.done) {
      throw new ValidationDeployInconclusiveError(
        'the deploy did not reach a terminal state',
        result
      )
    }
    if (!result.checkOnly) {
      // Defense in depth: checkOnly is hardcoded true in the request above,
      // so this can only fire if something between here and the org itself
      // (a mock in a test, or a future refactor) stopped sending it. Either
      // way, this bed must never treat a non-checkOnly result as valid
      // evidence — that would mean it just permanently deployed a mutant.
      throw new ValidationDeployInconclusiveError(
        'the deploy result was not checkOnly',
        result
      )
    }
    if (result.numberComponentErrors === 0 && !result.runTestsEnabled) {
      throw new ValidationDeployInconclusiveError(
        'runTestsEnabled was false — no test evidence was requested',
        result
      )
    }
    if (result.numberComponentErrors === 0) {
      const runTestResult = result.details.runTestResult
      if (!runTestResult) {
        throw new ValidationDeployInconclusiveError(
          'the deploy compiled but returned no runTestResult',
          result
        )
      }
      if (runTestResult.numTestsRun <= 0) {
        throw new ValidationDeployInconclusiveError(
          'the deploy compiled but numTestsRun was zero',
          result
        )
      }
      const reportedCount =
        runTestResult.successes.length + runTestResult.failures.length
      if (reportedCount !== runTestResult.numTestsRun) {
        throw new ValidationDeployInconclusiveError(
          `numTestsRun (${runTestResult.numTestsRun}) does not match the reported successes+failures (${reportedCount})`,
          result
        )
      }
      if (runTestResult.numFailures !== runTestResult.failures.length) {
        throw new ValidationDeployInconclusiveError(
          `numFailures (${runTestResult.numFailures}) does not match the reported failures (${runTestResult.failures.length})`,
          result
        )
      }
    }
  }

  private requireOriginal(): ApexClass {
    if (!this.original) {
      throw new Error(
        'ValidationOrgMutationTestBed: prepare() must run before evaluate() or restore()'
      )
    }
    return this.original
  }
}
