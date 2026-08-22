// Not from orca. This is the gate that makes `herdr-api-types.ts` a transcription rather than a
// guess: it reads the CI-enforced schema artefact (`docs/next/api/herdr-api.schema.json`) and the
// TypeScript source side by side, and fails on any drift in field names, optionality or enum
// members. orca had no equivalent because its desktop and mobile halves shared one TS type
// directory (`src/shared`, port map §6 risk 1); herdr's server is Rust, so the schema is the seam.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@herdr/client-ts'
import { describe, expect, it } from 'vitest'

const SCHEMA_PATH = fileURLToPath(new URL('../../../docs/next/api/herdr-api.schema.json', import.meta.url))
const TYPES_PATH = fileURLToPath(new URL('./herdr-api-types.ts', import.meta.url))

type SchemaObject = {
  properties?: Record<string, unknown>
  required?: string[]
  enum?: string[]
}

const schemaFile = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
  protocol: number
  schemas: { success_response: { $defs: Record<string, SchemaObject> } }
}
const defs = schemaFile.schemas.success_response.$defs
const typesSource = readFileSync(TYPES_PATH, 'utf8')

/** Fields declared on `export type <name> = { … }`, split by the `?` marker. */
function declaredObject(name: string): { required: string[]; optional: string[] } {
  const match = new RegExp(`export type ${name} = \\{\\n([\\s\\S]*?)\\n\\}`).exec(typesSource)
  if (!match) {
    throw new Error(`herdr-api-types.ts declares no object type ${name}`)
  }
  const required: string[] = []
  const optional: string[] = []
  for (const line of match[1].split('\n')) {
    const field = /^ {2}(\w+)(\??):/.exec(line)
    if (!field) {
      continue
    }
    ;(field[2] === '?' ? optional : required).push(field[1])
  }
  return { required, optional }
}

/** Members of `export type <name> = 'a' | 'b'`, single- or multi-line. */
function declaredEnum(name: string): string[] {
  const match = new RegExp(`export type ${name} =([^\\n]*(?:\\n {2}\\|[^\\n]*)*)`).exec(typesSource)
  if (!match) {
    throw new Error(`herdr-api-types.ts declares no type ${name}`)
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((member) => member[1])
}

// [tsName, schemaDefName] — the mapping is explicit so a rename on either side is a test failure.
const OBJECT_TYPES: Array<[string, string]> = [
  ['RemoteDefinition', 'RemoteDefinitionSnapshot'],
  ['WorkspaceGitInfo', 'WorkspaceGitInfo'],
  ['WorkspaceWorktreeInfo', 'WorkspaceWorktreeInfo'],
  ['WorkspaceInfo', 'WorkspaceInfo'],
  ['AgentSessionInfo', 'AgentSessionInfo'],
  ['PaneScrollInfo', 'PaneScrollInfo'],
  ['PaneInfo', 'PaneInfo'],
  ['AgentInfo', 'AgentInfo']
]

const ENUM_TYPES: Array<[string, string]> = [
  ['AgentStatus', 'AgentStatus'],
  ['RemoteKeybindings', 'RemoteKeybindingsSnapshot'],
  ['AgentSessionRefKind', 'AgentSessionRefKind']
]

describe('herdr JSON API type transcription', () => {
  // Against `PROTOCOL_VERSION` rather than a literal: the number is bumped whenever the wire
  // changes (20 -> 21 for the wire-ABI prelude), and a literal here only ever records which bump
  // last broke this file. Bound to the constant, the assertion says the thing worth saying — the
  // schema artefact this file transcribes and the codec mobile actually dials with are the same
  // protocol — and it keeps failing for the one reason it should: the two drifting apart.
  it('is written against the protocol the repo ships', () => {
    expect(schemaFile.protocol).toBe(PROTOCOL_VERSION)
  })

  it.each(OBJECT_TYPES)('%s declares exactly the required fields of %s', (tsName, defName) => {
    const schema = defs[defName]
    expect(schema, `${defName} missing from the schema`).toBeDefined()
    const declared = declaredObject(tsName)
    expect(declared.required.slice().sort()).toEqual((schema.required ?? []).slice().sort())
  })

  it.each(OBJECT_TYPES)('%s declares no field %s does not have', (tsName, defName) => {
    const known = Object.keys(defs[defName].properties ?? {})
    const declared = declaredObject(tsName)
    for (const field of [...declared.required, ...declared.optional]) {
      expect(known, `${tsName}.${field} is not in ${defName}`).toContain(field)
    }
  })

  it.each(ENUM_TYPES)('%s has the same members as %s', (tsName, defName) => {
    expect(declaredEnum(tsName).slice().sort()).toEqual((defs[defName].enum ?? []).slice().sort())
  })

  it('models RemoteTarget as the two-variant tagged union the schema declares', () => {
    const variants = (defs['RemoteTargetSnapshot'] as { oneOf: SchemaObject[] }).oneOf
    const tags = variants.map((variant) => {
      const tag = (variant.properties ?? {})['type'] as { const?: string } | undefined
      return tag?.const ?? ''
    })
    expect(tags).toEqual(['ssh', 'local'])
    expect(declaredEnum('RemoteTarget')).toEqual(expect.arrayContaining(tags))
  })

  it('names the four list results the mock server serves', () => {
    expect(typesSource).toContain("type: 'remote_list'")
    expect(typesSource).toContain("type: 'workspace_list'")
    expect(typesSource).toContain("type: 'pane_list'")
    expect(typesSource).toContain("type: 'agent_list'")
  })
})
