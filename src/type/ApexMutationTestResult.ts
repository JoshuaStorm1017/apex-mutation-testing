import type { TestClassResolution } from './TestClassResolution.js'
import type { TestMethodId } from './TestMethodId.js'

export interface ApexMutationTestResult {
  sourceFile: string
  sourceFileContent: string
  testFiles: string[]
  testClassResolutions: TestClassResolution[]
  // Present only when the campaign stopped before every planned mutation was
  // evaluated (see GroupExecutor's circuit breaker in groupExecutor.ts) —
  // absent means every planned mutation reached a terminal status. `mutants`
  // never contains an entry for an unattempted mutation; this is the only
  // place its existence and count are recorded, so a consumer (the CLI, the
  // HTML report) can say so explicitly rather than silently reporting fewer
  // mutants than were planned with no indication why.
  incomplete?: {
    evaluatedCount: number
    plannedCount: number
  }
  mutants: {
    id: string
    mutatorName: string
    status:
      | 'Killed'
      | 'Survived'
      | 'NoCoverage'
      | 'CompileError'
      | 'RuntimeError'
      | 'Pending'
    statusReason?: string
    // Presence means "this mutant was run and we know who ran it"; absence
    // means "no run data". The three fields are meaningful only together.
    attribution?: {
      coveredBy: TestMethodId[] // sorted, non-empty
      killedBy: TestMethodId[] // sorted, possibly empty
      testsCompleted: number
    }
    location: {
      start: { line: number; column: number }
      end: { line: number; column: number }
    }
    replacement: string
    original: string
  }[]
}
