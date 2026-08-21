#!/usr/bin/env npx tsx
// Rewritten for herdr; the orca original (mobile/scripts/mock-server.ts @ 4fd93ead, MIT /
// Lovecast Inc.) is the shape but not the content — see mobile/THIRD_PARTY_NOTICES.md.
//
// What is orca's: the *role* — a standalone fake server so the mobile app can be developed with no
// desktop running, printing its scenario summary at startup and taking scenario knobs from the
// environment (mock-server.ts:1-4, :131-137). What is herdr's: the entire transport, because the
// two protocols share nothing. orca's mock is a `ws` WebSocket server that performs an E2EE
// handshake (`e2ee_hello` → `e2ee_ready` → `e2ee_auth`) and then exchanges long-lived encrypted RPC
// frames. herdr's control plane is a *unix socket* speaking one newline-delimited JSON request per
// connection, with no auth on the wire — ssh is the authentication (01-spec.md), and
// `src/api/server.rs:139-152` reads exactly one line and returns.
//
// The dispatch and the fixture are deliberately NOT here: they live under `src/api/mock/` where
// vitest collects them (`mock-api-schema.test.ts` validates every payload against
// docs/next/api/herdr-api.schema.json). This file is only the socket, so there is nothing in it a
// test could have caught.
//
//   pnpm mock-server                       # unix socket at $TMPDIR/herdr-mobile-mock/herdr.sock
//   HERDR_MOCK_SOCKET=/tmp/x.sock pnpm mock-server
//   HERDR_MOCK_PORT=7420 pnpm mock-server  # TCP instead, for a device on the LAN
//
// Scenario knobs (all optional, all deterministic):
//   MOCK_REMOTE_COUNT · MOCK_WORKSPACE_COUNT · MOCK_PANES_PER_WORKSPACE · MOCK_API_DELAY_MS
import { createServer, type Socket } from 'node:net'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleMockApiLine } from '../src/api/mock/mock-api-handlers'
import { DEFAULT_SCENARIO, type MockScenario } from '../src/api/mock/mock-fixture'

// Ported behaviour from orca's `readScenarioNumber` (mobile-lag-scenario.ts:18-25): a knob that is
// unset or not a finite non-negative number falls back rather than producing a broken scenario.
function readScenarioNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

const scenario: MockScenario = {
  remoteCount: readScenarioNumber('MOCK_REMOTE_COUNT', DEFAULT_SCENARIO.remoteCount),
  workspaceCount: readScenarioNumber('MOCK_WORKSPACE_COUNT', DEFAULT_SCENARIO.workspaceCount),
  panesPerWorkspace: readScenarioNumber(
    'MOCK_PANES_PER_WORKSPACE',
    DEFAULT_SCENARIO.panesPerWorkspace
  )
}
const delayMs = readScenarioNumber('MOCK_API_DELAY_MS', 0)

const socketPath = process.env['HERDR_MOCK_SOCKET'] ?? join(tmpdir(), 'herdr-mobile-mock', 'herdr.sock')
const tcpPort = process.env['HERDR_MOCK_PORT'] ? Number(process.env['HERDR_MOCK_PORT']) : null

const server = createServer((socket: Socket) => {
  // One request is one connection: read until the first newline, answer, close. Anything the peer
  // writes after that is ignored, exactly as the real server ignores it.
  let buffer = ''
  let answered = false

  socket.on('data', (chunk) => {
    if (answered) {
      return
    }
    buffer += chunk.toString('utf8')
    const newline = buffer.indexOf('\n')
    if (newline === -1) {
      return
    }
    answered = true
    const line = buffer.slice(0, newline).trim()
    if (line.length === 0) {
      socket.end()
      return
    }
    const reply = handleMockApiLine(line, scenario)
    const send = () => {
      socket.end(reply)
      const method = (JSON.parse(line) as { method?: string }).method ?? '(unparsed)'
      console.log(`[mock] ${method} -> ${reply.length} bytes`)
    }
    if (delayMs > 0) {
      setTimeout(send, delayMs)
    } else {
      send()
    }
  })

  socket.on('error', () => socket.destroy())
})

function shutdown(): void {
  server.close()
  if (tcpPort === null) {
    rmSync(socketPath, { force: true })
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const summary = `${scenario.remoteCount} remotes, ${scenario.workspaceCount} workspaces, ${scenario.panesPerWorkspace} panes/workspace, ${delayMs}ms delay`

if (tcpPort === null) {
  mkdirSync(dirname(socketPath), { recursive: true })
  rmSync(socketPath, { force: true })
  server.listen(socketPath, () => {
    console.log(`[mock] herdr JSON API mock listening on unix:${socketPath}`)
    console.log(`[mock] Scenario: ${summary}`)
    console.log(`[mock] Try: printf '{"id":"1","method":"agent.list","params":{}}\\n' | nc -U ${socketPath}`)
  })
} else {
  server.listen(tcpPort, () => {
    console.log(`[mock] herdr JSON API mock listening on tcp:${tcpPort}`)
    console.log(`[mock] Scenario: ${summary}`)
  })
}
