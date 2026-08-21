// Not from orca. orca's mock server answers its own desktop's RPC and nothing checks the fixture
// against a contract — the contract *is* the shared TypeScript. herdr's server is Rust and publishes
// `docs/next/api/herdr-api.schema.json`, so the mock's payloads can be checked against the real
// thing. That check is what makes the P1 boundary trustworthy: a screen fed by this mock is fed
// objects the server could actually have sent, so "works against the mock, breaks against the
// server" is a bug in the transport, not in the fixture.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { handleMockApiRequest } from './mock-api-handlers'
import { DEFAULT_SCENARIO } from './mock-fixture'

type SchemaNode = {
  properties?: Record<string, SchemaNode>
  /**
   * Open maps. `state_labels` and `tokens` are `HashMap<String, String>` on the Rust side, so
   * schemars emits them with no `properties` at all and the value schema under
   * `additionalProperties`. Before stage 5 no fixture populated either map, so every object the
   * validator saw was closed and this branch was missing — which made it reject a *legal* payload
   * (`state_labels: {blocked: 'waiting for approval'}`) as "not declared in the schema".
   */
  additionalProperties?: SchemaNode | boolean
  required?: string[]
  enum?: string[]
  type?: string | string[]
  $ref?: string
  anyOf?: SchemaNode[]
  oneOf?: SchemaNode[]
}

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../docs/next/api/herdr-api.schema.json', import.meta.url)),
    'utf8'
  )
) as { schemas: { success_response: { $defs: Record<string, SchemaNode> } } }
const defs = schema.schemas.success_response.$defs

function resolve(node: SchemaNode): SchemaNode {
  if (!node.$ref) {
    return node
  }
  const name = node.$ref.split('/').pop()!
  const target = defs[name]
  if (!target) {
    throw new Error(`unresolvable $ref ${node.$ref}`)
  }
  return target
}

/** Returns the problems found, so a failure names the field rather than just "false". */
function validate(value: unknown, node: SchemaNode, path: string): string[] {
  const resolved = resolve(node)
  if (resolved.anyOf) {
    return resolved.anyOf.some((option) => validate(value, option, path).length === 0)
      ? []
      : [`${path}: matches no anyOf branch`]
  }
  if (resolved.oneOf) {
    return resolved.oneOf.some((option) => validate(value, option, path).length === 0)
      ? []
      : [`${path}: matches no oneOf branch`]
  }
  const types = resolved.type === undefined ? [] : [resolved.type].flat()
  if (value === null) {
    return types.includes('null') ? [] : [`${path}: null is not allowed`]
  }
  if (resolved.enum) {
    return resolved.enum.includes(value as string) ? [] : [`${path}: ${String(value)} not in enum`]
  }
  if (types.includes('array')) {
    return Array.isArray(value) ? [] : [`${path}: expected array`]
  }
  if (types.includes('integer') || types.includes('number')) {
    return typeof value === 'number' ? [] : [`${path}: expected number`]
  }
  if (types.includes('boolean')) {
    return typeof value === 'boolean' ? [] : [`${path}: expected boolean`]
  }
  if (types.includes('string') && !resolved.properties) {
    return typeof value === 'string' ? [] : [`${path}: expected string`]
  }

  if (typeof value !== 'object') {
    return [`${path}: expected object`]
  }
  const object = value as Record<string, unknown>
  const problems: string[] = []
  for (const field of resolved.required ?? []) {
    if (!(field in object) || object[field] === undefined) {
      problems.push(`${path}.${field}: required but missing`)
    }
  }
  const extra = resolved.additionalProperties
  for (const [field, raw] of Object.entries(object)) {
    const child =
      resolved.properties?.[field] ?? (typeof extra === 'object' ? extra : undefined)
    if (!child) {
      problems.push(`${path}.${field}: not declared in the schema`)
      continue
    }
    problems.push(...validate(raw, child, `${path}.${field}`))
  }
  return problems
}

function resultOf(method: string, params?: Record<string, unknown>) {
  const response = handleMockApiRequest({ id: 'ts-1', method, params })
  if ('error' in response) {
    throw new Error(`${method} answered with an error envelope: ${response.error.message}`)
  }
  return response.result
}

const CASES: Array<[string, string, string]> = [
  ['remote.list', 'remotes', 'RemoteDefinitionSnapshot'],
  ['workspace.list', 'workspaces', 'WorkspaceInfo'],
  ['pane.list', 'panes', 'PaneInfo'],
  ['agent.list', 'agents', 'AgentInfo']
]

describe('mock API payloads validate against docs/next/api/herdr-api.schema.json', () => {
  it.each(CASES)('%s items are valid %s', (method, key, defName) => {
    const items = resultOf(method)[key] as unknown[]
    expect(items.length).toBeGreaterThan(0)
    const problems = items.flatMap((item, index) =>
      validate(item, defs[defName]!, `${defName}[${index}]`)
    )
    expect(problems).toEqual([])
  })

  it('rejects a payload with a field the schema does not declare (the validator is not vacuous)', () => {
    const problems = validate(
      { ...(resultOf('pane.list')['panes'] as Record<string, unknown>[])[0], nope: 1 },
      defs['PaneInfo']!,
      'PaneInfo[0]'
    )
    expect(problems).toEqual(['PaneInfo[0].nope: not declared in the schema'])
  })

  it('rejects a payload missing a required field (the validator is not vacuous)', () => {
    const { pane_id: _dropped, ...rest } = (
      resultOf('pane.list')['panes'] as Record<string, unknown>[]
    )[0]!
    expect(validate(rest, defs['PaneInfo']!, 'PaneInfo[0]')).toEqual([
      'PaneInfo[0].pane_id: required but missing'
    ])
  })

  it('still rejects a bad *value* inside an open map (additionalProperties is not a bypass)', () => {
    const pane = (resultOf('pane.list')['panes'] as Record<string, unknown>[])[0]!
    expect(
      validate({ ...pane, state_labels: { blocked: 7 } }, defs['PaneInfo']!, 'PaneInfo[0]')
    ).toEqual(['PaneInfo[0].state_labels.blocked: expected string'])
  })

  it('accepts the state_labels the fixture actually emits', () => {
    const labelled = (resultOf('pane.list')['panes'] as Array<{ state_labels?: object }>).filter(
      (pane) => Object.keys(pane.state_labels ?? {}).length > 0
    )
    expect(labelled.length).toBeGreaterThan(0)
    expect(
      labelled.flatMap((pane, index) => validate(pane, defs['PaneInfo']!, `PaneInfo[${index}]`))
    ).toEqual([])
  })

  it('serves every workspace the scenario declares, and filters panes by workspace_id', () => {
    const workspaces = resultOf('workspace.list')['workspaces'] as Array<{ workspace_id: string }>
    expect(workspaces).toHaveLength(DEFAULT_SCENARIO.workspaceCount)
    const filtered = resultOf('pane.list', { workspace_id: 'ws-2' })['panes'] as Array<{
      workspace_id: string
    }>
    expect(filtered).toHaveLength(DEFAULT_SCENARIO.panesPerWorkspace)
    expect(new Set(filtered.map((pane) => pane.workspace_id))).toEqual(new Set(['ws-2']))
  })
})
