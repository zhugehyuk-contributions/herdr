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
  parseRemoteConfig,
  type HerdrSshRemoteConfig,
  type ParsedRemoteConfigs,
  type RejectedRemoteConfig,
  type RemoteConfigParse
} from './src/remote-config'
export {
  clearStoredRemotes,
  deleteStoredRemote,
  loadStoredRemoteSummaries,
  loadStoredRemotes,
  purgeIfFreshInstall,
  saveStoredRemote,
  summariseRemote,
  storedRemotesRevision,
  subscribeStoredRemotes,
  updateStoredRemote,
  STORED_REMOTE_ID_PATTERN,
  type FreshInstallOutcome,
  type StoredRemoteEdit,
  type StoredRemoteInventory,
  type StoredRemoteSummary,
  type StoredRemoteSummaries
} from './src/remote-store'
export { readBundledRemotes } from './src/bundled-remotes'
export {
  bundledFallbackAllowed,
  loadRemoteInventory,
  selectRemotes,
  type RemoteInventory,
  type RemoteSelection,
  type RemoteSource
} from './src/remote-source'
export {
  describePrivateKey,
  privateKeyAdvisories,
  type PrivateKeyContainer,
  type PrivateKeyDescriptor
} from './src/private-key-format'
export type {
  NativeChannelClose,
  NativeHerdrSsh,
  NativeSshChannel,
  NativeSshConnectConfig,
  NativeSshConnection
} from './src/native-types'
