import type { DeployResult } from '@jsforce/jsforce-node/lib/api/metadata/schema.js'
import { Connection } from '@salesforce/core'
import { Progress, Spinner } from '@salesforce/sf-plugins-core'
import type { ApexSettingsRepository } from '../../../../src/adapter/org/apexSettingsRepository.js'
import type { ApexTestRunner } from '../../../../src/adapter/org/apexTestRunner.js'
import type { OrganizationRepository } from '../../../../src/adapter/org/organizationRepository.js'
import { ValidationOrgMutationTestBed } from '../../../../src/adapter/org/validationMutationTestBed.js'
import { MutantGenerator } from '../../../../src/service/mutantGenerator.js'
import { MutationTestingService } from '../../../../src/service/mutationTestingService.js'
import { TypeDiscoverer } from '../../../../src/service/typeDiscoverer.js'
import { ApexMutation } from '../../../../src/type/ApexMutation.js'
import { ApexMutationParameter } from '../../../../src/type/ApexMutationParameter.js'
import {
  fakeSchemaProvider,
  fakeSourceProvider,
  keyEchoingMessages,
} from '../../../utils/testUtil.js'

vi.mock('../../../../src/service/mutantGenerator.js')
vi.mock('../../../../src/service/typeDiscoverer.js')

// This is the end-to-end version of the "no permanent update" proof: real
// MutationTestingService, real GroupExecutor (nothing about the mutation
// loop itself is mocked), real ValidationOrgMutationTestBed — only the
// jsforce Connection's metadata.deploy call, the read-only coverage query,
// and the org-safety/settings reads are stubbed. Every scenario below reads
// every call this test recorded against `deployMock` (not just the final
// one) and asserts `checkOnly: true` on each — proving the invariant holds
// across the whole run, not just in the happy path — plus that
// restore()/rollback issues no deploy of its own on any path, success or
// failure. validationMutationTestBed.test.ts already proves the adapter's
// own methods in isolation; this file proves the orchestration around it
// never finds a way to slip a real deploy through.
describe('ValidationOrgMutationTestBed — no permanent mutation, end to end', () => {
  let progress: Progress
  let spinner: Spinner
  let deployMock: ReturnType<typeof vi.fn>
  let completeMock: ReturnType<typeof vi.fn>
  let isSandboxMock: ReturnType<typeof vi.fn>
  let getTestMethodsPerLinesMock: ReturnType<typeof vi.fn>
  let mockMutation: ApexMutation

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

  const buildService = (): {
    service: MutationTestingService
    engine: {
      source: ReturnType<typeof fakeSourceProvider>
      schema: ReturnType<typeof fakeSchemaProvider>
      testBed: ValidationOrgMutationTestBed
    }
  } => {
    const connectionStub = {
      version: '62.0',
      metadata: { deploy: deployMock },
    } as unknown as Connection
    const apexTestRunnerStub = {
      getTestMethodsPerLines: getTestMethodsPerLinesMock,
    } as unknown as ApexTestRunner
    const organizationRepositoryStub = {
      isSandbox: isSandboxMock,
    } as unknown as OrganizationRepository
    const settingsStub = {
      isAggregateCoverageOnly: vi.fn().mockResolvedValue(false),
    } as unknown as ApexSettingsRepository
    const testBed = new ValidationOrgMutationTestBed(
      connectionStub,
      apexTestRunnerStub,
      organizationRepositoryStub,
      settingsStub
    )
    const engine = {
      source: fakeSourceProvider({
        readClass: vi.fn().mockResolvedValue({
          Id: '01p000000000001',
          Body: 'public class MyClass { }',
        }),
      }),
      schema: fakeSchemaProvider(),
      testBed,
    }
    const service = new MutationTestingService(
      progress,
      spinner,
      engine as never,
      {
        apexClassName: 'MyClass',
        apexTestClassNames: ['TestClass'],
      } as ApexMutationParameter,
      keyEchoingMessages()
    )
    return { service, engine }
  }

  // Every deploy call recorded across the whole test, in order — the
  // assertion in each scenario below walks this rather than just the last
  // call, so a bug that only shows up on (say) the mutant deploy and not the
  // baseline deploy cannot hide.
  const assertEveryDeployWasCheckOnly = (): void => {
    expect(deployMock.mock.calls.length).toBeGreaterThan(0)
    for (const call of deployMock.mock.calls) {
      const options = call[1] as { checkOnly?: boolean }
      expect(options.checkOnly).toBe(true)
    }
  }

  beforeEach(() => {
    progress = {
      start: vi.fn(),
      update: vi.fn(),
      finish: vi.fn(),
    } as unknown as Progress
    spinner = { start: vi.fn(), stop: vi.fn() } as unknown as Spinner
    completeMock = vi.fn().mockResolvedValue(validDeployResult())
    deployMock = vi.fn().mockReturnValue({ complete: completeMock })
    isSandboxMock = vi.fn().mockResolvedValue(true)
    getTestMethodsPerLinesMock = vi.fn().mockResolvedValue({
      outcome: 'Passed',
      testsRan: 1,
      compileFailures: [],
      otherFailureCount: 0,
      testMethodsPerLine: new Map([[1, new Set(['TestClassId.testA'])]]),
    })
    mockMutation = {
      mutationName: 'TestMutation',
      replacement: '0',
      target: {
        startToken: {
          line: 1,
          charPositionInLine: 60,
          tokenIndex: 5,
          startIndex: 60,
          stopIndex: 61,
          text: '42',
        } as ApexMutation['target']['startToken'],
        endToken: {
          line: 1,
          charPositionInLine: 60,
          tokenIndex: 5,
          startIndex: 60,
          stopIndex: 61,
          text: '42',
        } as ApexMutation['target']['endToken'],
        text: '42',
      },
    }
    vi.mocked(MutantGenerator).mockImplementation(
      class {
        compute = vi
          .fn()
          .mockReturnValue({ mutations: [mockMutation], tokenStream: {} })
        mutate = vi.fn().mockReturnValue('mutated code')
        mutateMany = vi.fn().mockReturnValue('mutated code')
      }
    )
    vi.mocked(TypeDiscoverer).mockImplementation(
      class {
        withMatcher = vi.fn().mockReturnThis()
        analyze = vi.fn().mockResolvedValue({})
        analyzeFull = vi.fn().mockResolvedValue({
          typeRegistry: {},
          tree: {} as never,
          tokenStream: {} as never,
        })
      } as never
    )
  })

  it('Given a clean run where the mutant survives, When the whole lifecycle completes, Then every deploy call was checkOnly and restore issues no deploy of its own', async () => {
    // Arrange — mutant compiles, its covering test passes (Survived).
    completeMock.mockResolvedValue(
      validDeployResult({
        details: {
          componentFailures: [],
          componentSuccesses: [],
          runTestResult: {
            numFailures: 0,
            numTestsRun: 1,
            totalTime: 0,
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
      } as never)
    )
    const { service } = buildService()

    // Act
    const result = await service.process()

    // Assert
    expect(result.mutants[0].status).toBe('Survived')
    assertEveryDeployWasCheckOnly()
    // Baseline (1) + mutant evaluate (1) = 2, never a 3rd "restore" deploy —
    // restore() is a true no-op for this bed.
    expect(deployMock).toHaveBeenCalledTimes(2)
  })

  it('Given a clean run where the mutant is killed, When the whole lifecycle completes, Then every deploy call was checkOnly and restore issues no deploy of its own', async () => {
    // Arrange — baseline succeeds, then the mutant's covering test fails.
    let call = 0
    completeMock.mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.resolve(validDeployResult())
      return Promise.resolve(
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
    })
    const { service } = buildService()

    // Act
    const result = await service.process()

    // Assert
    expect(result.mutants[0].status).toBe('Killed')
    assertEveryDeployWasCheckOnly()
    expect(deployMock).toHaveBeenCalledTimes(2)
  })

  it('Given the mutant deploy throws an infrastructure error, When the whole lifecycle completes, Then it is classified RuntimeError (never Killed/Survived), every deploy call was still checkOnly, and restore issues no deploy of its own', async () => {
    // Arrange — baseline succeeds, mutant evaluate() throws.
    let call = 0
    completeMock.mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.resolve(validDeployResult())
      return Promise.reject(new Error('ECONNRESET'))
    })
    const { service } = buildService()

    // Act
    const result = await service.process()

    // Assert
    expect(result.mutants[0].status).toBe('RuntimeError')
    expect(result.mutants[0].statusReason).toBe('ECONNRESET')
    assertEveryDeployWasCheckOnly()
    expect(deployMock).toHaveBeenCalledTimes(2)
  })

  it('Given the baseline itself throws, When the run aborts, Then no deploy was ever attempted (the org-safety and baseline gate fire before anything else) and restore is never reached', async () => {
    // Arrange
    isSandboxMock.mockResolvedValue(false)
    const { service } = buildService()

    // Act & Assert
    await expect(service.process()).rejects.toThrow()
    expect(deployMock).not.toHaveBeenCalled()
  })

  it('Given the baseline deploy compiles but is inconclusive (missing runTestResult), When the run aborts, Then the one deploy attempt was still checkOnly and no further deploy (including no restore deploy) follows', async () => {
    // Arrange
    completeMock.mockResolvedValue(
      validDeployResult({
        details: { componentFailures: [], componentSuccesses: [] },
      } as never)
    )
    const { service } = buildService()

    // Act & Assert
    await expect(service.process()).rejects.toThrow()
    assertEveryDeployWasCheckOnly()
    expect(deployMock).toHaveBeenCalledTimes(1)
  })
})
