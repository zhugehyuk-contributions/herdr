// Not from orca. Public entry of the `herdr-ssh` local Expo module.
//
// Everything exported here is safe to import from the app: no `expo-modules-core`, no
// `expo-constants`, no `react-native` at module scope (see `native-module.ts` for why that matters).
// The native module is reached only through the dynamic import inside `openConfiguredSshConnections`.
export {
  useHerdrSshConnections,
  openConfiguredSshConnections,
  type DialedRemotes,
  type SshDialState
} from './src/app-connections'
export {
  NativeSshHerdrTransport,
  toChannelClose,
  type NativeSshTransportOptions
} from './src/ssh-transport'
export {
  parseConfiguredRemotes,
  type HerdrSshRemoteConfig,
  type ParsedRemoteConfigs,
  type RejectedRemoteConfig
} from './src/remote-config'
export type {
  NativeChannelClose,
  NativeHerdrSsh,
  NativeSshChannel,
  NativeSshConnectConfig,
  NativeSshConnection
} from './src/native-types'
