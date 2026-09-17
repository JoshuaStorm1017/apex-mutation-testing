import { ZipFile } from 'yazl'

// Builds the Metadata API deploy zip for a single ApexClass member — the
// smallest package the check-only deploy path in validationMutationTestBed.ts
// needs. This is the only file in src/ that constructs a Metadata API
// package: everywhere else in this fork deploys through the Tooling API's
// MetadataContainer (see apexClassRepository.ts), which has no check-only
// mode at all — the Metadata API's deploy() is the only transport that does,
// which is why validation mode needs its own package/deploy path rather than
// reusing the Tooling API adapter (see DESIGN.md's validation-mode section
// for the full rationale).
//
// className is validated upstream against the Apex identifier grammar
// (ConfigReader / ApexClassValidator) before this is ever called, so it can
// never contain XML-special characters — no escaping is performed here
// because there is nothing legal for it to escape.

const PACKAGE_XML = (className: string, apiVersion: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>${className}</members>
        <name>ApexClass</name>
    </types>
    <version>${apiVersion}</version>
</Package>
`

const CLASS_META_XML = (apiVersion: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>${apiVersion}</apiVersion>
    <status>Active</status>
</ApexClass>
`

// yazl's ZipFile is stream-based (see the package's own README) — end()
// signals no more entries, and the returned promise resolves once
// outputStream has finished buffering into memory. A mutation-testing
// package is a handful of kilobytes at most (one class body plus two tiny
// XML files), so buffering the whole thing is the right tradeoff against
// yazl's own "don't block the thread" streaming design, which exists for
// far larger archives than this ever produces.
async function collectZip(zipfile: ZipFile): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    zipfile.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zipfile.outputStream.on('error', reject)
  })
}

export async function buildValidationDeployPackage(
  className: string,
  apexBody: string,
  apiVersion: string
): Promise<Buffer> {
  const zipfile = new ZipFile()
  zipfile.addBuffer(
    Buffer.from(PACKAGE_XML(className, apiVersion), 'utf8'),
    'package.xml'
  )
  zipfile.addBuffer(Buffer.from(apexBody, 'utf8'), `classes/${className}.cls`)
  zipfile.addBuffer(
    Buffer.from(CLASS_META_XML(apiVersion), 'utf8'),
    `classes/${className}.cls-meta.xml`
  )
  const done = collectZip(zipfile)
  zipfile.end()
  return done
}
