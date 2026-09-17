import { Messages } from '@salesforce/core'
import { Flags, SfCommand } from '@salesforce/sf-plugins-core'
import { createOrgEngine } from '../../../../adapter/org/orgEngine.js'
import {
  ApexClassAmbiguousError,
  ApexClassNotFoundError,
  ApexClassNotMutableError,
  ApexClassUnqualifiedError,
} from '../../../../port/apexClassErrors.js'
import type { ApexSourceProvider } from '../../../../port/apexSourceProvider.js'
import type { EngineBundle } from '../../../../port/executionEngine.js'
import { ApexMutationHTMLReporter } from '../../../../reporter/HTMLReporter.js'
import { ApexClassValidator } from '../../../../service/apexClassValidator.js'
import { ConfigReader } from '../../../../service/configReader.js'
import { reportEngineNotice } from '../../../../service/engineNotice.js'
import { MutationTestingService } from '../../../../service/mutationTestingService.js'
import {
  formatSkippedTestClasses,
  sanitizeForDisplay,
} from '../../../../service/skippedTestClassMessage.js'
import { TestSuiteResolver } from '../../../../service/testSuiteResolver.js'
import { ApexMutationParameter } from '../../../../type/ApexMutationParameter.js'
import type { ApexMutationTestResult as MutationProcessResult } from '../../../../type/ApexMutationTestResult.js'
import {
  attachSuiteProvenance,
  reducePerimeter,
} from '../../../../type/SkippedTestClass.js'
import type { TestClassResolutions } from '../../../../type/TestClassResolution.js'

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url)
const messages = Messages.loadMessages(
  'apex-mutation-testing',
  'apex.mutation.test.run'
)

export type ApexMutationTestResult = {
  score: number | null
}

// Every rejection from validate/assessPerimeter passes through here.
// ApexClassNotFoundError renders as the command's own error; anything else
// is rethrown untouched — no rejection reason is swallowed. className is
// user-typed and pinned to the identifier grammar before any org call, so it
// needs no sanitizing; states and spellings embed org-supplied
// ManageableState/NamespacePrefix values, unconstrained by any grammar on
// the aer local backend, so each is sanitized the same way
// skippedTestClassMessage.ts sanitizes org-supplied text.
function renderTargetClassError(error: unknown): never {
  if (error instanceof ApexClassNotFoundError) {
    throw messages.createError('error.apexClassNotFound', [error.className])
  }
  if (error instanceof ApexClassNotMutableError) {
    throw messages.createError('error.apexClassNotMutable', [
      error.className,
      error.states.map(sanitizeForDisplay).join(', '),
    ])
  }
  if (error instanceof ApexClassAmbiguousError) {
    throw messages.createError('error.apexClassAmbiguous', [
      error.className,
      error.spellings.map(sanitizeForDisplay).join(', '),
    ])
  }
  if (error instanceof ApexClassUnqualifiedError) {
    throw messages.createError('error.apexClassUnqualified', [
      error.className,
      sanitizeForDisplay(error.spelling),
    ])
  }
  throw error
}

// Builds the one free-text fragment error.scoreUnavailable interpolates.
// Only called when mutationTestingService.hasOperationalErrors is true, so
// exactly one of these three cases holds.
function describeUnavailableScore(result: MutationProcessResult): string {
  if (result.mutants.length === 0) {
    return 'no mutants were evaluated'
  }
  const inconclusive = result.mutants.filter(
    m => m.status === 'RuntimeError'
  ).length
  if (inconclusive === 0) {
    // Every evaluated mutant is invalid (CompileError) with none
    // RuntimeError: calculateScore's denominator is empty, so there is
    // nothing to compute a real score from.
    return `all ${result.mutants.length} evaluated mutant(s) failed to compile - none produced usable test evidence`
  }
  return `${inconclusive} of ${result.mutants.length} evaluated mutant(s) hit an infrastructure error (network, authentication, deploy/poll timeout, or similar) or produced no conclusive test evidence`
}

export default class ApexMutationTest extends SfCommand<ApexMutationTestResult> {
  public static override readonly summary = messages.getMessage('summary')
  public static override readonly description =
    messages.getMessage('description')
  public static override readonly examples = messages.getMessages('examples')

  public static override readonly flags = {
    'apex-class': Flags.string({
      char: 'c',
      summary: messages.getMessage('flags.apex-class.summary'),
      required: true,
    }),
    'test-class': Flags.string({
      char: 't',
      summary: messages.getMessage('flags.test-class.summary'),
      multiple: true,
      delimiter: ',',
      atLeastOne: ['test-class', 'test-suite'],
    }),
    'test-suite': Flags.string({
      summary: messages.getMessage('flags.test-suite.summary'),
      multiple: true,
      delimiter: ',',
      atLeastOne: ['test-class', 'test-suite'],
    }),
    'report-dir': Flags.directory({
      char: 'r',
      summary: messages.getMessage('flags.report-dir.summary'),
      exists: true,
      default: 'mutations',
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      summary: messages.getMessage('flags.dry-run.summary'),
      default: false,
    }),
    'include-mutators': Flags.string({
      summary: messages.getMessage('flags.include-mutators.summary'),
      exclusive: ['exclude-mutators'],
      multiple: true,
    }),
    'exclude-mutators': Flags.string({
      summary: messages.getMessage('flags.exclude-mutators.summary'),
      exclusive: ['include-mutators'],
      multiple: true,
    }),
    'include-test-methods': Flags.string({
      summary: messages.getMessage('flags.include-test-methods.summary'),
      exclusive: ['exclude-test-methods'],
      multiple: true,
    }),
    'exclude-test-methods': Flags.string({
      summary: messages.getMessage('flags.exclude-test-methods.summary'),
      exclusive: ['include-test-methods'],
      multiple: true,
    }),
    threshold: Flags.integer({
      summary: messages.getMessage('flags.threshold.summary'),
      min: 0,
      max: 100,
    }),
    'skip-patterns': Flags.string({
      char: 's',
      summary: messages.getMessage('flags.skip-patterns.summary'),
      multiple: true,
    }),
    lines: Flags.string({
      char: 'l',
      summary: messages.getMessage('flags.lines.summary'),
      multiple: true,
    }),
    'config-file': Flags.file({
      summary: messages.getMessage('flags.config-file.summary'),
      exists: true,
    }),
    'mutation-grouping': Flags.boolean({
      summary: messages.getMessage('flags.mutation-grouping.summary'),
    }),
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
  }

  public async run(): Promise<ApexMutationTestResult> {
    const { flags } = await this.parse(ApexMutationTest)
    const connection = flags['target-org'].getConnection(flags['api-version'])

    const engine = await createOrgEngine({
      connection,
      notify: notice => reportEngineNotice(notice, this.spinner, messages),
    })

    return this.mutate(engine, flags)
  }

  private async mutate(
    engine: EngineBundle,
    flags: Awaited<ReturnType<ApexMutationTest['parse']>>['flags']
  ): Promise<ApexMutationTestResult> {
    const parameters: ApexMutationParameter = {
      apexClassName: flags['apex-class'],
      apexTestClassNames: flags['test-class'] ?? [],
      apexTestSuiteNames: flags['test-suite'],
      reportDir: flags['report-dir'],
      dryRun: flags['dry-run'],
      includeMutators: flags['include-mutators'],
      excludeMutators: flags['exclude-mutators'],
      includeTestMethods: flags['include-test-methods'],
      excludeTestMethods: flags['exclude-test-methods'],
      threshold: flags['threshold'],
      skipPatterns: flags['skip-patterns'],
      lines: flags['lines'],
      configFile: flags['config-file'],
      mutationGrouping: flags['mutation-grouping'],
    }

    const resolvedParameters = await this.resolveParameters(
      parameters,
      engine.source
    )
    this.logRunningLine(resolvedParameters)

    const { usable, resolutions } = await this.reduceToUsablePerimeter(
      resolvedParameters,
      engine.source
    )

    const mutationTestingService = new MutationTestingService(
      this.progress,
      this.spinner,
      engine,
      {
        ...resolvedParameters,
        apexTestClassNames: usable,
        testClassResolutions: resolutions,
      },
      messages
    )
    const mutationResult = await mutationTestingService.process()

    await this.publishReport(mutationResult, resolvedParameters.reportDir)

    if (mutationResult.incomplete) {
      // Mutations the campaign never reached are absent from
      // mutationResult.mutants entirely (see executeMutationLoop) — this is
      // the only place their existence is surfaced, so it must be explicit
      // rather than the report silently looking smaller than planned.
      const { evaluatedCount, plannedCount } = mutationResult.incomplete
      this.warn(
        messages.getMessage('info.campaignIncomplete', [
          String(evaluatedCount),
          String(plannedCount),
          String(plannedCount - evaluatedCount),
        ])
      )
    }

    if (
      !resolvedParameters.dryRun &&
      mutationTestingService.hasOperationalErrors(mutationResult)
    ) {
      // Either a mutant hit an infrastructure error or produced no
      // conclusive test evidence, or nothing was scoreable at all (see
      // mutationTestingService.hasOperationalErrors) — the report above
      // still lists every evaluated mutant's real status and reason, but no
      // numeric score can be trusted, and the command must fail regardless
      // of whether the remaining, genuinely-evaluated mutants alone would
      // have cleared the configured threshold.
      throw messages.createError('error.scoreUnavailable', [
        describeUnavailableScore(mutationResult),
      ])
    }

    const score = resolvedParameters.dryRun
      ? null
      : mutationTestingService.calculateScore(mutationResult)

    if (score !== null) {
      this.log(messages.getMessage('info.CommandSuccess', [score]))
    }
    this.enforceThreshold(score, resolvedParameters.threshold)

    this.info(messages.getMessage('info.EncourageSponsorship'))
    return { score }
  }

  private async resolveParameters(
    parameters: ApexMutationParameter,
    source: ApexSourceProvider
  ): Promise<ApexMutationParameter> {
    const configReader = new ConfigReader(messages)
    const configuredParameters = await configReader.resolve(parameters)

    const testSuiteResolver = new TestSuiteResolver(source, messages)
    return testSuiteResolver.resolve(configuredParameters)
  }

  private logRunningLine(parameters: ApexMutationParameter): void {
    this.log(
      messages.getMessage(
        parameters.dryRun
          ? 'info.DryRunCommandIsRunning'
          : 'info.CommandIsRunning',
        [parameters.apexClassName, parameters.apexTestClassNames.join(', ')]
      )
    )
  }

  private async reduceToUsablePerimeter(
    parameters: ApexMutationParameter,
    source: ApexSourceProvider
  ): Promise<{ usable: string[]; resolutions: TestClassResolutions }> {
    const apexClassValidator = new ApexClassValidator(source)
    const [, perimeterAssessment] = await Promise.all([
      apexClassValidator.validate(parameters),
      apexClassValidator.assessPerimeter(parameters.apexTestClassNames),
    ]).catch(renderTargetClassError)

    const { skipped: verdicts, resolutions } = perimeterAssessment
    const skipped = attachSuiteProvenance(verdicts, parameters.testClassOrigins)
    const sentences = formatSkippedTestClasses(skipped, messages)
    sentences.forEach(sentence => this.warn(sentence))

    const usable = reducePerimeter(parameters.apexTestClassNames, skipped)
    if (usable.length === 0) {
      throw messages.createError('error.noUsableTestClass', [
        parameters.apexClassName,
        sentences.join('\n'),
      ])
    }
    return {
      usable,
      resolutions: new Map(resolutions.map(r => [r.classId, r])),
    }
  }

  private async publishReport(
    mutationResult: MutationProcessResult,
    reportDir: string
  ): Promise<void> {
    const htmlReporter = new ApexMutationHTMLReporter(messages)
    await htmlReporter.generateReport(mutationResult, reportDir)
    this.log(messages.getMessage('info.reportGenerated', [reportDir]))
  }

  private enforceThreshold(
    score: number | null,
    threshold: number | undefined
  ): void {
    if (score === null || threshold === undefined) return
    if (score < threshold) {
      throw messages.createError('error.thresholdNotMet', [
        String(score),
        String(threshold),
      ])
    }
  }
}
