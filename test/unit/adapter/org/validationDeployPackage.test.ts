import yauzl from 'yauzl'
import { buildValidationDeployPackage } from '../../../../src/adapter/org/validationDeployPackage.js'

// Round-trips the real zip through yauzl (a separate, independently-trusted
// library from yazl, the writer) rather than asserting on yazl's own output
// shape — proves the archive is actually well-formed and readable by
// something else, not just internally self-consistent.
function readZipEntries(buffer: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('no zipfile'))
      const entries = new Map<string, string>()
      zipfile.on('entry', entry => {
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) return reject(streamErr)
          const chunks: Buffer[] = []
          readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
          readStream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString('utf8'))
            zipfile.readEntry()
          })
          readStream.on('error', reject)
        })
      })
      zipfile.on('end', () => resolve(entries))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

describe('buildValidationDeployPackage', () => {
  it('Given a class name, body and API version, When building the package, Then the zip contains exactly package.xml, the class body and its meta.xml, byte-correct', async () => {
    // Act
    const buffer = await buildValidationDeployPackage(
      'MyClass',
      'public class MyClass { public static Integer getValue() { return 42; } }',
      '62.0'
    )
    const entries = await readZipEntries(buffer)

    // Assert — exactly these three entries, nothing extra
    expect([...entries.keys()].sort()).toEqual([
      'classes/MyClass.cls',
      'classes/MyClass.cls-meta.xml',
      'package.xml',
    ])

    // Assert — the class body is stored verbatim
    expect(entries.get('classes/MyClass.cls')).toBe(
      'public class MyClass { public static Integer getValue() { return 42; } }'
    )

    // Assert — package.xml names the right member, type and version
    const packageXml = entries.get('package.xml')!
    expect(packageXml).toContain('<members>MyClass</members>')
    expect(packageXml).toContain('<name>ApexClass</name>')
    expect(packageXml).toContain('<version>62.0</version>')

    // Assert — the class meta.xml carries the right API version and is Active
    const metaXml = entries.get('classes/MyClass.cls-meta.xml')!
    expect(metaXml).toContain('<apiVersion>62.0</apiVersion>')
    expect(metaXml).toContain('<status>Active</status>')
  })

  it('Given a mutated body containing XML-special characters (<, >, &), When building the package, Then the class file entry still round-trips byte-for-byte', async () => {
    // Arrange — Apex source legitimately contains these characters
    // (comparisons, boolean ops); the class *file* is stored raw inside the
    // zip, not embedded in XML, so nothing here needs escaping — this proves
    // that rather than assuming it.
    const body =
      'public class MyClass { public static Boolean check(Integer a, Integer b) { return a < b && b > 0; } }'

    // Act
    const buffer = await buildValidationDeployPackage('MyClass', body, '62.0')
    const entries = await readZipEntries(buffer)

    // Assert
    expect(entries.get('classes/MyClass.cls')).toBe(body)
  })

  it('Given two different class names, When building each package, Then each zip names only its own class in package.xml and meta.xml paths', async () => {
    // Act
    const bufferA = await buildValidationDeployPackage(
      'FooClass',
      'public class FooClass {}',
      '61.0'
    )
    const bufferB = await buildValidationDeployPackage(
      'BarClass',
      'public class BarClass {}',
      '61.0'
    )
    const entriesA = await readZipEntries(bufferA)
    const entriesB = await readZipEntries(bufferB)

    // Assert — no cross-contamination between the two independent builds
    expect([...entriesA.keys()].sort()).toEqual([
      'classes/FooClass.cls',
      'classes/FooClass.cls-meta.xml',
      'package.xml',
    ])
    expect([...entriesB.keys()].sort()).toEqual([
      'classes/BarClass.cls',
      'classes/BarClass.cls-meta.xml',
      'package.xml',
    ])
    expect(entriesA.get('package.xml')).toContain('<members>FooClass</members>')
    expect(entriesB.get('package.xml')).toContain('<members>BarClass</members>')
  })
})
