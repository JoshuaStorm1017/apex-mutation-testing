import {
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { Messages } from '@salesforce/core'
import { ApexMutationHTMLReporter } from '../../../src/reporter/HTMLReporter.js'
import { ApexMutationTestResult } from '../../../src/type/ApexMutationTestResult.js'

// Deliberately does NOT `vi.mock('node:fs/promises')`: the other HTMLReporter
// test file proves the temp-file-then-rename call shape against a mock, but
// a mock cannot prove the actual OS-level guarantee this fix relies on —
// that fs.rename() replaces a symlink's directory entry rather than writing
// through it to the link's target. This file exercises the real filesystem
// against a real symlink to prove that directly (Codex review finding: a
// planted `reports/index.html -> outside-project.txt` symlink previously had
// its target overwritten).
describe('HTMLReporter symlink safety (real filesystem)', () => {
  let sut: ApexMutationHTMLReporter
  let workDir: string
  let outsideTarget: string

  const messagesStub = {
    getMessage: vi.fn((key: string) => key),
  } as unknown as Messages<string>

  const minimalResult: ApexMutationTestResult = {
    sourceFile: 'TestClass',
    sourceFileContent: 'public class TestClass {}',
    testFiles: [],
    testClassResolutions: [],
    mutants: [],
  }

  beforeEach(async () => {
    sut = new ApexMutationHTMLReporter(messagesStub)
    // Created under process.cwd() so resolveSafeOutputDir's containment
    // check accepts it without needing to chdir the whole test process.
    workDir = await mkdtemp(
      path.join(process.cwd(), '.htmlreporter-symlink-test-')
    )
    // Named off workDir's own random suffix so parallel test runs never
    // collide on this path; still a sibling of workDir, i.e. outside the
    // report output directory itself, which is the boundary this fix
    // defends (the directory-level checks only validate workDir's own
    // resolution, never what a symlink inside it points to).
    outsideTarget = `${workDir}-outside-project.txt`
    await writeFile(outsideTarget, 'do not touch me')
    await symlink(outsideTarget, path.join(workDir, 'index.html'))
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
    await rm(outsideTarget, { force: true })
  })

  it('Given index.html is a symlink to a file outside the output dir, When generating a report, Then the symlink target is left untouched and the symlink itself is replaced with the report', async () => {
    // Act
    await sut.generateReport(minimalResult, workDir)

    // Assert — the file the symlink pointed at still holds its original
    // content, never overwritten through the link.
    expect(await readFile(outsideTarget, 'utf8')).toBe('do not touch me')

    // Assert — the path that was a symlink is now a real file holding the
    // report (readlink throws EINVAL/ENOENT on a non-symlink, proving the
    // link itself was replaced, not followed).
    await expect(readlink(path.join(workDir, 'index.html'))).rejects.toThrow()
    const written = await readFile(path.join(workDir, 'index.html'), 'utf8')
    expect(written).toContain('<mutation-test-report-app')

    // Assert — no leftover temp file from the write-then-rename sequence.
    const entries = await readdir(workDir)
    expect(entries).toEqual(['index.html'])

    // Assert — real on-disk permission bits, not a mocked call argument: the
    // report embeds the full class source plus every covering test's
    // identity, so it defaults to owner-only (0600), not world-readable.
    const mode = (await stat(path.join(workDir, 'index.html'))).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
