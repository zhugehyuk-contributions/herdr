// Not from orca. The M4 receipt needs to *cause* the failure it claims to recover from, and the
// failure is "the network went away", not "something called close()". Those are not the same event
// and only the first one is interesting: a clean `close()` delivers an event, and code that
// recovers from an event it was handed proves nothing about #5049, whose entire subject is the
// failure that delivers nothing.
//
// So this is a TCP proxy that can be severed. `cut()` destroys every socket in both directions and
// starts refusing new connections; `heal()` starts accepting again. That is what an airplane-mode
// toggle and a Wi-Fi→cellular handoff look like from the app's side of the wire, and it reproduces
// them **without touching any process**: no signal is sent, no pid is matched, the developer's
// long-lived `herdr` daemons are never involved. (The suite spawns its own sshd and its own server
// and signals only those two pids — same rule as
// `packages/herdr-client-ts/test/live-ssh/sshHarness.ts`.)
//
// Why in front of sshd rather than in front of the herdr socket: the app's whole transport is the
// ssh connection (02-architecture.md §2.1). Cutting below it kills the exec channels, the JSON API
// and the client stream at once, from the same cause, with no notification — which is exactly the
// blast radius a real radio outage has.
import { createServer, connect, type Server, type Socket } from 'node:net'

export interface NetworkCutter {
  /** Dial this instead of the real port. */
  readonly port: number
  /** TCP connections this proxy has accepted. A reconnect shows up here. */
  readonly accepted: number
  /** Kills every live connection and refuses new ones. No event is sent to the peer. */
  cut: () => void
  /** Starts accepting again. Existing (destroyed) connections are not restored. */
  heal: () => void
  close: () => Promise<void>
}

/** An unused TCP port, obtained by binding one and letting go. Mirrors the sshd harness. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        rejectPort(new Error('could not determine a free port'))
        return
      }
      const { port } = address
      probe.close(() => resolvePort(port))
    })
  })
}

export async function startNetworkCutter(targetPort: number): Promise<NetworkCutter> {
  const port = await freePort()
  const live = new Set<Socket>()
  let severed = false
  let accepted = 0

  const server: Server = createServer((client) => {
    accepted += 1
    if (severed) {
      client.destroy()
      return
    }
    const upstream = connect(targetPort, '127.0.0.1')
    live.add(client)
    live.add(upstream)
    const drop = (): void => {
      live.delete(client)
      live.delete(upstream)
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', drop)
    upstream.on('close', drop)
    client.pipe(upstream)
    upstream.pipe(client)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', () => resolveListen())
  })

  return {
    port,
    get accepted() {
      return accepted
    },
    cut() {
      severed = true
      for (const socket of live) {
        // `destroy`, not `end`: a FIN is a *notification*, and the point is to deliver none.
        socket.destroy()
      }
      live.clear()
    },
    heal() {
      severed = false
    },
    close() {
      for (const socket of live) {
        socket.destroy()
      }
      live.clear()
      return new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  }
}
