import { Connection } from '@salesforce/core'

interface OrganizationRow {
  NamespacePrefix: string | null
}

interface OrganizationSandboxRow {
  IsSandbox: boolean
}

export class OrganizationRepository {
  constructor(private readonly connection: Connection) {}

  // Organization is a singleton object: exactly one row always exists. A
  // plain (non-Tooling) query is enough — namespacedness is org metadata,
  // not a Tooling API concern.
  public async readNamespacePrefix(): Promise<string | null> {
    const result = await this.connection.query<OrganizationRow>(
      'SELECT NamespacePrefix FROM Organization'
    )
    // `||`, not `??`: the org can report the "no namespace" case as either
    // `null` or `''`, and both must normalise the same way — isOwnNamespace's
    // folding treats them alike, so the earliest read must too.
    return result.records[0]?.NamespacePrefix || null
  }

  // `IsSandbox` is the field Salesforce itself uses to distinguish a
  // production org from every non-production one — a sandbox and a scratch
  // org (which is a Draft-edition sandbox under the covers) both report
  // `true`; only a real production org reports `false`. Used exclusively by
  // validationMutationTestBed.ts to refuse validation mode against
  // production before any deploy is attempted — never by the original
  // (Tooling API) backend, which already carries whatever org-safety
  // upstream itself relies on.
  public async isSandbox(): Promise<boolean> {
    const result = await this.connection.query<OrganizationSandboxRow>(
      'SELECT IsSandbox FROM Organization'
    )
    return result.records[0]?.IsSandbox === true
  }
}
