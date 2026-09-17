import type { DeployResult } from '@jsforce/jsforce-node/lib/api/metadata/schema.js'
import { Connection } from '@salesforce/core'
import type { ApexSettingsRepository } from '../../../../src/adapter/org/apexSettingsRepository.js'
import type { ApexTestRunner } from '../../../../src/adapter/org/apexTestRunner.js'
import type { OrganizationRepository } from '../../../../src/adapter/org/organizationRepository.js'
import {
  ValidationDeployInconclusiveError,
  ValidationModeProductionOrgError,
  ValidationOrgMutationTestBed,
} from '../../../../src/adapter/org/validationMutationTestBed.js'
import type { PrepareHooks } from '../../../../src/port/mutationTestBed.js'
import { CompilationCheckFailedError } from '../../../../src/port/mutationTestBed.js'
import type { ApexClass } from '../../../../src/type/ApexClass.js'
import type { TestMethodId } from '../../../../src/type/TestMethodId.js'

const ORIGINAL: ApexClass = {
  Id: '01p000000000001',
  Body: 'public class MyClass { }',
}
const noopHooks: PrepareHooks = {
  onVerifying: vi.fn(),
  onVerified: vi.fn(),
  onBaselineStarting: vi.fn(),
}

// A terminal, successful, checkOnly, test-evidenced DeployResult — every test
// below starts from a spread of this and overrides exactly the field(s) it
// is proving, so each failing-path test changes the one thing that makes it
// fail rather than constructing a whole new fixture that could accidentally
// be wrong in an unrelated way.
const validDeployResult = (
  overrides: Partial<DeployResult> = {}
): DeployResult =>
  ({
    id: '0Af000000000001',
    status: 'Succeeded',
    done: true,
    checkOnly: true,
    success: true,
    runTestsEnabled: true,
    numberComponentErrors: 0,
    numberComponentsDeployed: 1,
    numberComponentsTotal: 1,
    numberTestErrors: 0,
    numberTestsCompleted: 1,
    numberTestsTotal: 1,
    createdBy: '005000000000001',
    createdByName: 'Test User',
    createdDate: '2026-01-01T00:00:00.000Z',
    ignoreWarnings: true,
    rollbackOnError: true,
    details: {
      componentFailures: [],
      componentSuccesses: [],
      runTestResult: {
        numFailures: 0,
        numTestsRun: 1,
        totalTime: 100,
        codeCoverage: [],
        codeCoverageWarnings: [],
        flowCoverage: [],
        flowCoverageWarnings: [],
        failures: [],
        successes: [
          { id: 'TestClassId', methodName: 'testA', name: 'TestClass' },
        ],
      },
    },
    ...overrides,
  }) as unknown as DeployResult

describe('ValidationOrgMutationTestBed', () => {
  let deployMock: ReturnType<typeof vi.fn>
  let completeMock: ReturnType<typeof vi.fn>
  let connectionStub: Connection
  let apexTestRunnerStub: ApexTestRunner
  let organizationRepositoryStub: OrganizationRepository
  let settingsStub: ApexSettingsRepository
  let getTestMethodsPerLinesMock: ReturnType<typeof vi.fn>
  let isSandboxMock: ReturnType<typeof vi.fn>
  let sut: ValidationOrgMutationTestBed

  beforeEach(() => {
    completeMock = vi.fn().mockResolvedValue(validDeployResult())
    deployMock = vi.fn().mockReturnValue({ complete: completeMock })
    connectionStub = {
      version: '62.0',
      metadata: { deploy: deployMock },
    } as unknown as Connection
    getTestMethodsPerLinesMock = vi.fn().mockResolvedValue({
      outcome: 'Passed',
      testsRan: 1,
      compileFailures: [],
      otherFailureCount: 0,
      testMethodsPerLine: new Map([
        [1, new Set(['TestClassId.testA'] as TestMethodId[])],
      ]),
    })
    apexTestRunnerStub = {
      getTestMethodsPerLines: getTestMethodsPerLinesMock,
    } as unknown as ApexTestRunner
    isSandboxMock = vi.fn().mockResolvedValue(true)
    organizationRepositoryStub = {
      isSandbox: isSandboxMock,
    } as unknown as OrganizationRepository
    settingsStub = {
      isAggregateCoverageOnly: vi.fn().mockResolvedValue(false),
    } as unknown as ApexSettingsRepository
    sut = new ValidationOrgMutationTestBed(
      connectionStub,
      apexTestRunnerStub,
      organizationRepositoryStub,
      settingsStub
    )
  })

  describe('org safety', () => {
    it('Given a production org, When prepare is called, Then it throws before any deploy is attempted', async () => {
      // Arrange
      isSandboxMock.mockResolvedValue(false)

      // Act & Assert
      await expect(
        sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
      ).rejects.toThrow(ValidationModeProductionOrgError)
      expect(deployMock).not.toHaveBeenCalled()
    })

    it('Given the sandbox check itself cannot confirm status, When prepare is called, Then it fails closed (treated as production) before any deploy', async () => {
      // Arrange — isSandbox() itself already fails closed (see
      // organizationRepository.test.ts); this proves the bed relies on that
      // rather than re-interpreting a missing/ambiguous answer as safe.
      isSandboxMock.mockResolvedValue(false)

      // Act & Assert
      await expect(
        sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
      ).rejects.toThrow(ValidationModeProductionOrgError)
      expect(deployMock).not.toHaveBeenCalled()
    })
  })

  describe('every deploy request', () => {
    it('Given prepare is called, When the deploy request is built, Then it is always checkOnly with RunSpecifiedTests naming the perimeter classes', async () => {
      // Act
      await sut.prepare(ORIGINAL, ['FooTest', 'BarTest'], noopHooks)

      // Assert
      expect(deployMock).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          checkOnly: true,
          testLevel: 'RunSpecifiedTests',
          runTests: ['FooTest', 'BarTest'],
        })
      )
    })

    it('Given a perimeter with duplicate class names, When the deploy request is built, Then runTests is de-duplicated', async () => {
      // Act
      await sut.prepare(ORIGINAL, ['FooTest', 'FooTest', 'BarTest'], noopHooks)

      // Assert
      expect(deployMock).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ runTests: ['FooTest', 'BarTest'] })
      )
    })

    it('Given complete() is called, When polling for the deploy result, Then includeDetails is requested', async () => {
      // Act
      await sut.prepare(ORIGINAL, ['FooTest'], noopHooks)

      // Assert
      expect(completeMock).toHaveBeenCalledWith(true)
    })
  })

  describe('Given prepare, When the deploy result is not trustworthy', () => {
    it.each([
      ['not done (non-terminal)', { done: false }],
      ['not checkOnly', { checkOnly: false }],
      [
        'runTestsEnabled false',
        {
          runTestsEnabled: false,
          details: { componentFailures: [], componentSuccesses: [] },
        },
      ],
      [
        'missing runTestResult',
        { details: { componentFailures: [], componentSuccesses: [] } },
      ],
    ])(
      'Then a deploy that is %s throws ValidationDeployInconclusiveError',
      async (_description, overrides) => {
        // Arrange
        completeMock.mockResolvedValue(validDeployResult(overrides))

        // Act & Assert
        await expect(
          sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
        ).rejects.toThrow(ValidationDeployInconclusiveError)
      }
    )

    it('Then a deploy reporting zero numTestsRun throws ValidationDeployInconclusiveError', async () => {
      // Arrange
      completeMock.mockResolvedValue(
        validDeployResult({
          details: {
            componentFailures: [],
            componentSuccesses: [],
            runTestResult: {
              numFailures: 0,
              numTestsRun: 0,
              totalTime: 0,
              codeCoverage: [],
              codeCoverageWarnings: [],
              flowCoverage: [],
              flowCoverageWarnings: [],
              failures: [],
              successes: [],
            },
          },
        } as never)
      )

      // Act & Assert
      await expect(
        sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
      ).rejects.toThrow(ValidationDeployInconclusiveError)
    })

    it('Then a deploy whose numTestsRun disagrees with successes+failures throws ValidationDeployInconclusiveError', async () => {
      // Arrange — claims 5 ran but only reports 1
      completeMock.mockResolvedValue(
        validDeployResult({
          details: {
            componentFailures: [],
            componentSuccesses: [],
            runTestResult: {
              numFailures: 0,
              numTestsRun: 5,
              totalTime: 0,
              codeCoverage: [],
              codeCoverageWarnings: [],
              flowCoverage: [],
              flowCoverageWarnings: [],
              failures: [],
              successes: [{ id: 'A', methodName: 'testA', name: 'A' }],
            },
          },
        } as never)
      )

      // Act & Assert
      await expect(
        sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
      ).rejects.toThrow(ValidationDeployInconclusiveError)
    })

    it('Then a deploy whose numFailures disagrees with the reported failures array throws ValidationDeployInconclusiveError', async () => {
      // Arrange
      completeMock.mockResolvedValue(
        validDeployResult({
          details: {
            componentFailures: [],
            componentSuccesses: [],
            runTestResult: {
              numFailures: 3,
              numTestsRun: 1,
              totalTime: 0,
              codeCoverage: [],
              codeCoverageWarnings: [],
              flowCoverage: [],
              flowCoverageWarnings: [],
              failures: [],
              successes: [{ id: 'A', methodName: 'testA', name: 'A' }],
            },
          },
        } as never)
      )

      // Act & Assert
      await expect(
        sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
      ).rejects.toThrow(ValidationDeployInconclusiveError)
    })
  })

  describe('Given prepare, When the target class itself fails to compile', () => {
    it('Then it throws CompilationCheckFailedError, never treating it as a usable baseline', async () => {
      // Arrange
      completeMock.mockResolvedValue(
        validDeployResult({
          success: false,
          numberComponentErrors: 1,
          details: {
            componentFailures: [
              {
                fileName: 'classes/MyClass.cls',
                fullName: 'MyClass',
                success: false,
                changed: false,
                created: false,
                createdDate: '',
                deleted: false,
                problem: 'Invalid syntax',
                lineNumber: 3,
                columnNumber: 5,
              },
            ],
            componentSuccesses: [],
          },
        } as never)
      )

      // Act & Assert
      await expect(
        sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
      ).rejects.toThrow(CompilationCheckFailedError)
      // Never reaches the coverage read when the target class itself is
      // broken — there is nothing to score a baseline against.
      expect(getTestMethodsPerLinesMock).not.toHaveBeenCalled()
    })
  })

  describe('Given a valid baseline deploy', () => {
    it('Then prepare returns a Baseline built from the real deploy test counts and the real (Tooling API) coverage read, never from RunTestsResult.codeCoverage', async () => {
      // Act
      const baseline = await sut.prepare(ORIGINAL, ['TestClass'], noopHooks)

      // Assert
      expect(baseline.outcome).toBe('Passed')
      expect(baseline.testsRan).toBe(1)
      expect(baseline.otherFailureCount).toBe(0)
      expect(baseline.compileFailures).toEqual([])
      expect(baseline.testMethodsPerLine).toEqual(
        new Map([[1, new Set(['TestClassId.testA'])]])
      )
      expect(getTestMethodsPerLinesMock).toHaveBeenCalledWith(
        ['TestClass'],
        expect.anything()
      )
    })

    it('Given a baseline with genuine test failures, Then otherFailureCount reflects them honestly (never inflated to zero)', async () => {
      // Arrange
      completeMock.mockResolvedValue(
        validDeployResult({
          success: false,
          details: {
            componentFailures: [],
            componentSuccesses: [],
            runTestResult: {
              numFailures: 1,
              numTestsRun: 2,
              totalTime: 0,
              codeCoverage: [],
              codeCoverageWarnings: [],
              flowCoverage: [],
              flowCoverageWarnings: [],
              successes: [{ id: 'A', methodName: 'testA', name: 'A' }],
              failures: [
                {
                  id: 'A',
                  methodName: 'testB',
                  message: 'assertion failed',
                  name: 'A',
                  packageName: '',
                  time: 1,
                  type: 'Class',
                },
              ],
            },
          },
        } as never)
      )

      // Act
      const baseline = await sut.prepare(ORIGINAL, ['TestClass'], noopHooks)

      // Assert
      expect(baseline.outcome).toBe('Failed')
      expect(baseline.otherFailureCount).toBe(1)
    })

    it('Given the org has "Store Only Aggregated Code Coverage" enabled, Then the coverage read uses AggregateCoverageStrategy instead of the per-test default', async () => {
      // Arrange
      settingsStub.isAggregateCoverageOnly = vi.fn().mockResolvedValue(true)

      // Act
      await sut.prepare(ORIGINAL, ['TestClass'], noopHooks)

      // Assert — getTestMethodsPerLines is handed a strategy whose fidelity
      // is 'aggregate', not the 'per-test' default.
      const strategyArg = getTestMethodsPerLinesMock.mock.calls[0][1] as {
        fidelity: string
      }
      expect(strategyArg.fidelity).toBe('aggregate')
    })
  })

  describe('evaluate', () => {
    beforeEach(async () => {
      await sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
      deployMock.mockClear()
      completeMock.mockClear()
    })

    it('Given the mutant compiles and a covering test fails, When evaluating, Then it returns an executed verdict with a real Fail row', async () => {
      // Arrange
      completeMock.mockResolvedValue(
        validDeployResult({
          success: false,
          details: {
            componentFailures: [],
            componentSuccesses: [],
            runTestResult: {
              numFailures: 1,
              numTestsRun: 1,
              totalTime: 0,
              codeCoverage: [],
              codeCoverageWarnings: [],
              flowCoverage: [],
              flowCoverageWarnings: [],
              successes: [],
              failures: [
                {
                  id: 'TestClassId',
                  methodName: 'testA',
                  message: 'assert failed',
                  name: 'TestClass',
                  packageName: '',
                  time: 1,
                  type: 'Class',
                },
              ],
            },
          },
        } as never)
      )

      // Act
      const verdict = await sut.evaluate(
        'public class MyClass { /* mutated */ }',
        new Set(['TestClassId.testA'] as TestMethodId[])
      )

      // Assert
      expect(verdict.kind).toBe('executed')
      if (verdict.kind === 'executed') {
        expect(verdict.result.tests).toEqual([
          { classId: 'TestClassId', methodName: 'testA', outcome: 'Fail' },
        ])
      }
    })

    it('Given the mutant does not compile, When evaluating, Then it returns a not-compilable verdict, never an executed one', async () => {
      // Arrange
      completeMock.mockResolvedValue(
        validDeployResult({
          success: false,
          numberComponentErrors: 1,
          details: {
            componentFailures: [
              {
                fileName: 'classes/MyClass.cls',
                fullName: 'MyClass',
                success: false,
                changed: false,
                created: false,
                createdDate: '',
                deleted: false,
                problem: 'Unexpected token',
                lineNumber: 1,
                columnNumber: 1,
              },
            ],
            componentSuccesses: [],
          },
        } as never)
      )

      // Act
      const verdict = await sut.evaluate(
        'public class MyClass { garbage',
        new Set(['TestClassId.testA'] as TestMethodId[])
      )

      // Assert
      expect(verdict.kind).toBe('not-compilable')
      if (verdict.kind === 'not-compilable') {
        expect(verdict.detail).toContain('Unexpected token')
      }
    })

    it('Given a component failure with no line/column position and no problem text, When evaluating, Then the detail still renders without those fields rather than throwing', async () => {
      // Arrange — the Metadata API schema marks lineNumber, columnNumber and
      // problem all optional; a component-level (not line-level) failure can
      // legitimately omit them.
      completeMock.mockResolvedValue(
        validDeployResult({
          success: false,
          numberComponentErrors: 1,
          details: {
            componentFailures: [
              {
                fileName: 'classes/MyClass.cls',
                fullName: 'MyClass',
                success: false,
                changed: false,
                created: false,
                createdDate: '',
                deleted: false,
              },
            ],
            componentSuccesses: [],
          },
        } as never)
      )

      // Act
      const verdict = await sut.evaluate(
        'public class MyClass { }',
        new Set(['TestClassId.testA'] as TestMethodId[])
      )

      // Assert
      expect(verdict.kind).toBe('not-compilable')
      if (verdict.kind === 'not-compilable') {
        expect(verdict.detail).toContain('[classes/MyClass.cls]')
        expect(verdict.detail).toContain('Unknown error')
      }
    })

    it('Given a component failure with a line number but no column number, When evaluating, Then the detail falls back to column 0 rather than throwing', async () => {
      // Arrange
      completeMock.mockResolvedValue(
        validDeployResult({
          success: false,
          numberComponentErrors: 1,
          details: {
            componentFailures: [
              {
                fileName: 'classes/MyClass.cls',
                fullName: 'MyClass',
                success: false,
                changed: false,
                created: false,
                createdDate: '',
                deleted: false,
                problem: 'Invalid syntax',
                lineNumber: 5,
              },
            ],
            componentSuccesses: [],
          },
        } as never)
      )

      // Act
      const verdict = await sut.evaluate(
        'public class MyClass { }',
        new Set(['TestClassId.testA'] as TestMethodId[])
      )

      // Assert
      expect(verdict.kind).toBe('not-compilable')
      if (verdict.kind === 'not-compilable') {
        expect(verdict.detail).toContain('[classes/MyClass.cls:5:0]')
      }
    })

    it('Given a covering test fails at the class level with no methodName, When evaluating, Then the Fail row falls back to a sentinel method name rather than throwing', async () => {
      // Arrange
      completeMock.mockResolvedValue(
        validDeployResult({
          success: false,
          details: {
            componentFailures: [],
            componentSuccesses: [],
            runTestResult: {
              numFailures: 1,
              numTestsRun: 1,
              totalTime: 0,
              codeCoverage: [],
              codeCoverageWarnings: [],
              flowCoverage: [],
              flowCoverageWarnings: [],
              successes: [],
              failures: [
                {
                  id: 'TestClassId',
                  message: 'class-level failure',
                  name: 'TestClass',
                  packageName: '',
                  time: 1,
                  type: 'Class',
                },
              ],
            },
          },
        } as never)
      )

      // Act
      const verdict = await sut.evaluate(
        'public class MyClass { }',
        new Set(['TestClassId.testA'] as TestMethodId[])
      )

      // Assert
      expect(verdict.kind).toBe('executed')
      if (verdict.kind === 'executed') {
        expect(verdict.result.tests).toEqual([
          {
            classId: 'TestClassId',
            methodName: '<class-level failure>',
            outcome: 'Fail',
          },
        ])
      }
    })

    it('Given evaluate is called, When the deploy request is built, Then it is checkOnly and still names the full stored perimeter, regardless of the specific covering tests passed in', async () => {
      // Act — the covering set here (one method) deliberately does not
      // narrow the deploy request; see the class-level comment on evaluate()
      // for why (Metadata API test selection is class-granular only).
      await sut.evaluate(
        'public class MyClass { }',
        new Set(['TestClassId.testA'] as TestMethodId[])
      )

      // Assert
      expect(deployMock).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({
          checkOnly: true,
          runTests: ['TestClass'],
        })
      )
    })
  })

  describe('Given prepare has not run yet', () => {
    it('Then evaluate throws a clear precondition error rather than deploying with no original class to compare against', async () => {
      // Act & Assert
      await expect(
        sut.evaluate('public class MyClass { }', new Set())
      ).rejects.toThrow(
        'ValidationOrgMutationTestBed: prepare() must run before evaluate() or restore()'
      )
      expect(deployMock).not.toHaveBeenCalled()
    })

    it('Then restore still resolves as a no-op — it never needs the original class, since there is never anything to roll back', async () => {
      // Act & Assert
      await expect(sut.restore('run-tests' as never)).resolves.toBeUndefined()
      expect(deployMock).not.toHaveBeenCalled()
    })
  })

  describe('restore', () => {
    it('Given restore is called after a successful run, When it resolves, Then it issues no deploy at all — a check-only run was never committed', async () => {
      // Arrange
      await sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
      deployMock.mockClear()

      // Act
      await sut.restore('run-tests' as never)

      // Assert
      expect(deployMock).not.toHaveBeenCalled()
    })

    it('Given restore is called after a failed evaluate, When it resolves, Then it still issues no deploy', async () => {
      // Arrange
      await sut.prepare(ORIGINAL, ['TestClass'], noopHooks)
      deployMock.mockClear()
      completeMock.mockRejectedValueOnce(new Error('ECONNRESET'))
      await sut.evaluate('bad', new Set()).catch(() => {
        // Expected: evaluate() propagates the thrown error untouched (see
        // GroupExecutor's own catch/classify). Only restore()'s behaviour
        // after this failure is under test here.
      })
      deployMock.mockClear()

      // Act
      await sut.restore('skip-tests' as never)

      // Assert
      expect(deployMock).not.toHaveBeenCalled()
    })
  })
})
