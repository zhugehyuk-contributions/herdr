// Not from orca. The verb, per remote: "tell this host where to push."
//
// Shaped like `HerdrRemoteConnection.redialTransport` and for the same stated reason — it is the
// *missing verb*, not connection state and not a second place to keep policy. Who calls it and how
// often is `src/notifications/use-blocked-push.ts`; what it says is
// `src/notifications/push-token-registration.ts`; the ssh underneath is `./ssh-transport.ts`. This
// file is only the place those three meet, once, so the app tree never sees a command string.
//
// It exists at all because the alternative — handing the app a generic "run this on that host" —
// would put an arbitrary remote exec in every screen's reach for the sake of one caller.
import {
  registerPushTokenCommand,
  type PushTokenRegistration
} from '../../../src/notifications/push-token-registration'
import { commandFailure, type RemoteCommandRunner } from '../../../src/transport/remote-command'
import type { HerdrSshRemoteConfig } from './remote-config'

export interface PushTokenRegistrar {
  /** `RemoteDefinition.id` — the same id the sender's `sender.json` calls this machine. */
  remoteId: string
  /** Resolves when the remote wrote the token. Rejects with the remote's own explanation. */
  register(registration: PushTokenRegistration): Promise<void>
}

export function createPushTokenRegistrar(
  config: HerdrSshRemoteConfig,
  runner: RemoteCommandRunner
): PushTokenRegistrar {
  return {
    remoteId: config.id,
    async register(registration: PushTokenRegistration): Promise<void> {
      // Built per call rather than per dial: the registration carries a timestamp and the token can
      // rotate between launches, so there is nothing here worth caching and a cached command would
      // be the one that ships a stale token.
      const command = registerPushTokenCommand({
        registration,
        herdrBinary: config.herdrBinary,
        env: config.env
      })
      const result = await runner.runCommand(command)
      const failure = commandFailure(result)
      if (failure !== null) {
        // Prefixed with the remote id because the caller registers against N hosts at once and a
        // bare `exited 127: herdr: not found` says nothing about which of them is missing herdr.
        throw new Error(`${config.id}: ${failure}`)
      }
    }
  }
}
